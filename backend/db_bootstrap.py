from datetime import date

from sqlalchemy import inspect, text
from sqlalchemy.exc import SQLAlchemyError

from backend import database, models


def ensure_user_schema_columns() -> None:
    inspector = inspect(database.engine)
    if "users" not in inspector.get_table_names():
        return

    existing_columns = {column["name"] for column in inspector.get_columns("users")}
    required_columns = {
        "dob": "DATE",
        "address": "TEXT",
        "blood_group": "VARCHAR",
        "phone_number": "VARCHAR",
        "parent_phone_number": "VARCHAR",
        "face_samples": "JSON",
    }

    with database.engine.begin() as connection:
        for column_name, column_type in required_columns.items():
            if column_name in existing_columns:
                continue
            connection.execute(text(f"ALTER TABLE users ADD COLUMN {column_name} {column_type}"))


def ensure_settings_schema_columns() -> None:
    inspector = inspect(database.engine)
    if "settings" not in inspector.get_table_names():
        return

    existing_columns = {column["name"] for column in inspector.get_columns("settings")}
    required_columns = {
        "staff_morning_time_start": "TIME",
        "staff_morning_time_end": "TIME",
        "staff_evening_time_start": "TIME",
        "staff_evening_time_end": "TIME",
    }

    with database.engine.begin() as connection:
        for column_name, column_type in required_columns.items():
            if column_name in existing_columns:
                continue
            connection.execute(text(f"ALTER TABLE settings ADD COLUMN {column_name} {column_type}"))


def ensure_user_reference_cascade(table_name: str, column_name: str) -> None:
    if database.engine.dialect.name == "sqlite":
        return

    inspector = inspect(database.engine)
    if table_name not in inspector.get_table_names() or "users" not in inspector.get_table_names():
        return

    matching_foreign_keys = [
        foreign_key
        for foreign_key in inspector.get_foreign_keys(table_name)
        if foreign_key.get("referred_table") == "users"
        and foreign_key.get("constrained_columns") == [column_name]
    ]
    desired_constraint_name = f"{table_name}_{column_name}_fkey"

    if matching_foreign_keys:
        foreign_key = matching_foreign_keys[0]
        options = foreign_key.get("options") or {}
        if str(options.get("ondelete", "")).upper() == "CASCADE":
            return

        existing_constraint_name = foreign_key.get("name")
        with database.engine.begin() as connection:
            if existing_constraint_name:
                connection.execute(
                    text(
                        f'ALTER TABLE "{table_name}" DROP CONSTRAINT IF EXISTS "{existing_constraint_name}"'
                    )
                )
            connection.execute(
                text(
                    f'ALTER TABLE "{table_name}" '
                    f'ADD CONSTRAINT "{desired_constraint_name}" '
                    f'FOREIGN KEY ("{column_name}") REFERENCES "users"("id") ON DELETE CASCADE'
                )
            )
        return

    with database.engine.begin() as connection:
        connection.execute(
            text(
                f'ALTER TABLE "{table_name}" '
                f'ADD CONSTRAINT "{desired_constraint_name}" '
                f'FOREIGN KEY ("{column_name}") REFERENCES "users"("id") ON DELETE CASCADE'
            )
        )


def migrate_legacy_holidays_to_calendar_rules() -> None:
    db = database.SessionLocal()
    try:
        settings = db.query(models.Setting).first()
        if not settings:
            return

        existing_rule_keys = {
            (rule.start_date, rule.end_date, (rule.audience or "").strip().lower(), (rule.day_type or "").strip().lower())
            for rule in db.query(models.CalendarRule).all()
        }

        has_changes = False
        for holiday in settings.holidays or []:
            try:
                holiday_date = holiday if isinstance(holiday, date) else date.fromisoformat(str(holiday))
            except ValueError:
                continue

            rule_key = (holiday_date, holiday_date, "both", "holiday")
            if rule_key in existing_rule_keys:
                continue

            db.add(
                models.CalendarRule(
                    start_date=holiday_date,
                    end_date=holiday_date,
                    audience="both",
                    day_type="holiday",
                    reason="Imported legacy holiday",
                )
            )
            existing_rule_keys.add(rule_key)
            has_changes = True

        if has_changes:
            db.commit()
    finally:
        db.close()


def ensure_common_indexes() -> None:
    index_definitions = [
        ("ix_embeddings_user_id", "embeddings", "user_id"),
        ("ix_attendance_user_id", "attendance", "user_id"),
        ("ix_attendance_date", "attendance", "date"),
        ("ix_staff_class_assignments_staff_user_id", "staff_class_assignments", "staff_user_id"),
    ]

    inspector = inspect(database.engine)
    table_names = set(inspector.get_table_names())
    with database.engine.begin() as connection:
        for index_name, table_name, column_name in index_definitions:
            if table_name not in table_names:
                continue
            connection.execute(
                text(f'CREATE INDEX IF NOT EXISTS "{index_name}" ON "{table_name}" ("{column_name}")')
            )


def ensure_attendance_unique_constraint() -> None:
    if database.engine.dialect.name != "postgresql":
        return

    inspector = inspect(database.engine)
    if "attendance" not in inspector.get_table_names():
        return

    existing_constraint_names = {
        constraint.get("name")
        for constraint in inspector.get_unique_constraints("attendance")
    }
    if "uq_attendance_user_date_session" in existing_constraint_names:
        return

    try:
        with database.engine.begin() as connection:
            connection.execute(
                text(
                    'ALTER TABLE "attendance" '
                    'ADD CONSTRAINT "uq_attendance_user_date_session" '
                    'UNIQUE ("user_id", "date", "session")'
                )
            )
    except SQLAlchemyError as exc:
        print(
            "Warning: Could not add attendance uniqueness constraint. "
            "Check for duplicate attendance rows. "
            f"Error: {exc}"
        )


def initialize_database() -> None:
    models.Base.metadata.create_all(bind=database.engine)
    ensure_user_schema_columns()
    ensure_settings_schema_columns()
    ensure_user_reference_cascade("embeddings", "user_id")
    ensure_user_reference_cascade("attendance", "user_id")
    ensure_user_reference_cascade("staff_class_assignments", "staff_user_id")
    ensure_common_indexes()
    ensure_attendance_unique_constraint()
    migrate_legacy_holidays_to_calendar_rules()
