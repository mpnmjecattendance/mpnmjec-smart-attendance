"""Initial attendance schema.

Revision ID: 0001_initial_schema
Revises:
Create Date: 2026-05-07
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0001_initial_schema"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(), nullable=True),
        sa.Column("role", sa.String(), nullable=True),
        sa.Column("identifier", sa.String(), nullable=True),
        sa.Column("hashed_password", sa.String(), nullable=True),
        sa.Column("department", sa.String(), nullable=True),
        sa.Column("year", sa.Integer(), nullable=True),
        sa.Column("semester", sa.Integer(), nullable=True),
        sa.Column("dob", sa.Date(), nullable=True),
        sa.Column("address", sa.String(), nullable=True),
        sa.Column("blood_group", sa.String(), nullable=True),
        sa.Column("phone_number", sa.String(), nullable=True),
        sa.Column("parent_phone_number", sa.String(), nullable=True),
        sa.Column("face_samples", sa.JSON(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_users_id", "users", ["id"])
    op.create_index("ix_users_identifier", "users", ["identifier"], unique=True)
    op.create_index("ix_users_name", "users", ["name"])

    op.create_table(
        "embeddings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column("embedding_vector", sa.JSON(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_embeddings_id", "embeddings", ["id"])
    op.create_index("ix_embeddings_user_id", "embeddings", ["user_id"])

    op.create_table(
        "attendance",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column("date", sa.Date(), nullable=True),
        sa.Column("time", sa.Time(), nullable=True),
        sa.Column("session", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "date", "session", name="uq_attendance_user_date_session"),
    )
    op.create_index("ix_attendance_id", "attendance", ["id"])
    op.create_index("ix_attendance_user_id", "attendance", ["user_id"])
    op.create_index("ix_attendance_date", "attendance", ["date"])

    op.create_table(
        "staff_class_assignments",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("staff_user_id", sa.Integer(), nullable=True),
        sa.Column("department", sa.String(), nullable=False),
        sa.Column("year", sa.Integer(), nullable=False),
        sa.Column("semester", sa.Integer(), nullable=False),
        sa.Column("section", sa.String(), nullable=False, server_default="all"),
        sa.Column("assignment_type", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(["staff_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_staff_class_assignments_id", "staff_class_assignments", ["id"])
    op.create_index("ix_staff_class_assignments_staff_user_id", "staff_class_assignments", ["staff_user_id"])

    op.create_table(
        "settings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("holidays", sa.JSON(), nullable=True),
        sa.Column("morning_time_start", sa.Time(), nullable=True),
        sa.Column("morning_time_end", sa.Time(), nullable=True),
        sa.Column("afternoon_time_start", sa.Time(), nullable=True),
        sa.Column("afternoon_time_end", sa.Time(), nullable=True),
        sa.Column("staff_morning_time_start", sa.Time(), nullable=True),
        sa.Column("staff_morning_time_end", sa.Time(), nullable=True),
        sa.Column("staff_evening_time_start", sa.Time(), nullable=True),
        sa.Column("staff_evening_time_end", sa.Time(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_settings_id", "settings", ["id"])

    op.create_table(
        "calendar_rules",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=False),
        sa.Column("audience", sa.String(), nullable=False),
        sa.Column("day_type", sa.String(), nullable=False),
        sa.Column("reason", sa.String(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_calendar_rules_id", "calendar_rules", ["id"])
    op.create_index("ix_calendar_rules_start_date", "calendar_rules", ["start_date"])
    op.create_index("ix_calendar_rules_end_date", "calendar_rules", ["end_date"])


def downgrade() -> None:
    op.drop_index("ix_calendar_rules_end_date", table_name="calendar_rules")
    op.drop_index("ix_calendar_rules_start_date", table_name="calendar_rules")
    op.drop_index("ix_calendar_rules_id", table_name="calendar_rules")
    op.drop_table("calendar_rules")

    op.drop_index("ix_settings_id", table_name="settings")
    op.drop_table("settings")

    op.drop_index("ix_staff_class_assignments_staff_user_id", table_name="staff_class_assignments")
    op.drop_index("ix_staff_class_assignments_id", table_name="staff_class_assignments")
    op.drop_table("staff_class_assignments")

    op.drop_index("ix_attendance_date", table_name="attendance")
    op.drop_index("ix_attendance_user_id", table_name="attendance")
    op.drop_index("ix_attendance_id", table_name="attendance")
    op.drop_table("attendance")

    op.drop_index("ix_embeddings_user_id", table_name="embeddings")
    op.drop_index("ix_embeddings_id", table_name="embeddings")
    op.drop_table("embeddings")

    op.drop_index("ix_users_name", table_name="users")
    op.drop_index("ix_users_identifier", table_name="users")
    op.drop_index("ix_users_id", table_name="users")
    op.drop_table("users")
