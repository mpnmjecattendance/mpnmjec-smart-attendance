import csv
import io
import os
import sys
import zipfile
from collections import Counter, defaultdict
from datetime import date, datetime, time as dt_time, timedelta, timezone, tzinfo
from pathlib import Path
from typing import Any, Iterable, Optional
from xml.sax.saxutils import escape
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Query, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import and_, func, or_, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

load_dotenv(Path(__file__).resolve().with_name(".env"))

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import auth, database, models, schemas
from backend.database import get_db
from backend.db_bootstrap import initialize_database


initialize_database()

app = FastAPI(title="MPNMJEC Smart Attendance System API")

VALID_ROLES = {"admin", "hod", "advisor", "principal", "staff", "student"}
VALID_ASSIGNMENT_TYPES = {"attendance_operator", "class_advisor"}
PRESENT_STATUSES = {"present", "late"}
VALID_STATUSES = {"present", "late", "absent"}
VALID_SESSIONS = {"morning", "afternoon"}
DEFAULT_DASHBOARD_DAYS = 30
VALID_CALENDAR_AUDIENCES = {"students", "staff", "both"}
VALID_CALENDAR_DAY_TYPES = {"holiday", "working", "attendance_not_conducted"}
NON_COUNTED_SESSION_STATUSES = {"pending", "no_session", "attendance_not_conducted"}
VISIBLE_ATTENDANCE_DAY_TYPES = {"working", "attendance_not_conducted"}
ATTENDANCE_OPERATOR_ROLES = ("admin", "hod", "advisor", "principal", "staff")
INSTITUTE_ATTENDANCE_TARGET_ROLES = {"student", "staff", "hod", "principal"}
WORKING_WEEKDAYS = {0, 1, 2, 3, 4, 5}
DEPARTMENT_OPTIONS = [
    "Civil Engineering",
    "Computer Science and Engineering",
    "Electronics and Communication Engineering",
    "Electrical and Electronics Engineering",
    "Information Technology",
    "Mechanical Engineering",
    "Science and Humanities",
    "M.E.CAD/CAM",
    "M.E. Computer Science and Engineering",
    "M.E. Power System Engineering",
    "M.E. Structural Engineering",
    "M.E. VLSI Design",
    "Master of Business Administration",
    "Master of Computer Applications",
]
DEPARTMENT_OPTION_LOOKUP = {
    department.casefold(): department
    for department in DEPARTMENT_OPTIONS
}
FACE_RECOGNITION_THRESHOLD = float(os.getenv("FACE_RECOGNITION_THRESHOLD", "0.40"))
FACE_RECOGNITION_MIN_MARGIN = float(os.getenv("FACE_RECOGNITION_MIN_MARGIN", "0.03"))
CONFIGURED_ADMIN_IDENTIFIERS = {
    identifier.strip().lower()
    for identifier in {
        os.getenv("ADMIN_EMAIL", ""),
        "admin@mpnmjec.ac.in",
    }
    if identifier and identifier.strip()
}
DEFAULT_SETTINGS = {
    "holidays": [],
    "morning_time_start": dt_time(hour=8, minute=30),
    "morning_time_end": dt_time(hour=12, minute=30),
    "afternoon_time_start": dt_time(hour=13, minute=30),
    "afternoon_time_end": dt_time(hour=16, minute=30),
    "staff_morning_time_start": dt_time(hour=8, minute=30),
    "staff_morning_time_end": dt_time(hour=12, minute=30),
    "staff_evening_time_start": dt_time(hour=13, minute=30),
    "staff_evening_time_end": dt_time(hour=16, minute=30),
}
DEFAULT_APP_TIMEZONE = "Asia/Kolkata"
DEFAULT_APP_UTC_OFFSET = timezone(timedelta(hours=5, minutes=30), DEFAULT_APP_TIMEZONE)


def get_app_timezone() -> tzinfo:
    timezone_name = os.getenv("APP_TIMEZONE", DEFAULT_APP_TIMEZONE).strip() or DEFAULT_APP_TIMEZONE
    try:
        return ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError:
        if timezone_name != DEFAULT_APP_TIMEZONE:
            try:
                return ZoneInfo(DEFAULT_APP_TIMEZONE)
            except ZoneInfoNotFoundError:
                pass
        return DEFAULT_APP_UTC_OFFSET


def get_current_datetime() -> datetime:
    return datetime.now(get_app_timezone()).replace(tzinfo=None)


def get_current_date() -> date:
    return get_current_datetime().date()

allowed_origins = [
    origin.strip()
    for origin in os.getenv(
        "FRONTEND_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def preload_face_recognition() -> None:
    if os.getenv("PRELOAD_FACE_RECOGNITION", "true").strip().lower() not in {"1", "true", "yes", "on"}:
        return

    try:
        from . import ai_service
    except ImportError:
        import ai_service

    try:
        ai_service.ensure_face_recognition_available()
    except RuntimeError as exc:
        print(f"Warning: Face recognition preload skipped. Error: {exc}")
        return

    # Touch the singleton so model load/warmup happens during backend startup
    # instead of on the student's first kiosk scan.
    _ = ai_service.face_analyzer


def load_ai_service():
    try:
        from . import ai_service
    except ImportError:
        import ai_service

    try:
        ai_service.ensure_face_recognition_available()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    return ai_service


@app.get("/")
def read_root():
    return {"message": "Welcome to MPNMJEC Smart Attendance API"}


def normalize_role(role: Optional[str]) -> str:
    return (role or "").strip().lower()


def normalize_status(status_value: Optional[str]) -> str:
    return (status_value or "").strip().lower()


def validate_role(role: str) -> str:
    normalized = normalize_role(role)
    if normalized not in VALID_ROLES:
        raise HTTPException(status_code=400, detail="Invalid role supplied")
    return normalized


def normalize_calendar_audience(audience: Optional[str]) -> str:
    return (audience or "").strip().lower()


def validate_calendar_audience(audience: str) -> str:
    normalized = normalize_calendar_audience(audience)
    if normalized not in VALID_CALENDAR_AUDIENCES:
        raise HTTPException(status_code=400, detail="Audience must be students, staff, or both")
    return normalized


def normalize_calendar_day_type(day_type: Optional[str]) -> str:
    return (day_type or "").strip().lower()


def validate_calendar_day_type(day_type: str) -> str:
    normalized = normalize_calendar_day_type(day_type)
    if normalized not in VALID_CALENDAR_DAY_TYPES:
        raise HTTPException(status_code=400, detail="Day type must be holiday, working, or attendance_not_conducted")
    return normalized


def normalize_department_name(department: Optional[str]) -> str:
    return (department or "").strip()


def validate_department_name(
    department: Optional[str],
    *,
    required: bool = True,
) -> Optional[str]:
    normalized = normalize_department_name(department)
    if not normalized:
        if required:
            raise HTTPException(status_code=400, detail="Department is required")
        return None

    canonical_department = DEPARTMENT_OPTION_LOOKUP.get(normalized.casefold())
    if not canonical_department:
        raise HTTPException(status_code=400, detail="Invalid department supplied")

    return canonical_department


def order_departments_by_catalog(departments: Iterable[Optional[str]]) -> list[str]:
    available_departments: set[str] = set()
    for department in departments:
        normalized = normalize_department_name(department)
        canonical_department = DEPARTMENT_OPTION_LOOKUP.get(normalized.casefold())
        if canonical_department:
            available_departments.add(canonical_department)

    return [
        department
        for department in DEPARTMENT_OPTIONS
        if department in available_departments
    ]


def get_department_options_for_user(current_user: models.User) -> list[str]:
    role = get_effective_role(current_user)

    if role in {"admin", "principal"}:
        return list(DEPARTMENT_OPTIONS)

    if role in {"hod", "advisor", "student"}:
        scoped_departments = order_departments_by_catalog([current_user.department])
        return scoped_departments or list(DEPARTMENT_OPTIONS)

    if role == "staff":
        assignment_departments = [
            assignment.department
            for assignment in get_user_class_assignments(current_user)
        ]
        scoped_departments = order_departments_by_catalog(assignment_departments or [current_user.department])
        return scoped_departments or list(DEPARTMENT_OPTIONS)

    return list(DEPARTMENT_OPTIONS)


def normalize_assignment_type(assignment_type: Optional[str]) -> str:
    return (assignment_type or "").strip().lower()


def validate_assignment_type(assignment_type: str) -> str:
    normalized = normalize_assignment_type(assignment_type)
    if normalized not in VALID_ASSIGNMENT_TYPES:
        raise HTTPException(status_code=400, detail="Invalid class assignment type supplied")
    return normalized


def validate_session(session_name: str) -> str:
    normalized = (session_name or "").strip().lower()
    if normalized not in VALID_SESSIONS:
        raise HTTPException(status_code=400, detail="Session must be morning or afternoon")
    return normalized


def validate_status(status_name: str) -> str:
    normalized = normalize_status(status_name)
    if normalized not in VALID_STATUSES:
        raise HTTPException(status_code=400, detail="Status must be present, late, or absent")
    return normalized


def validate_institute_attendance_role(role: str) -> str:
    normalized = validate_role(role)
    if normalized not in INSTITUTE_ATTENDANCE_TARGET_ROLES:
        raise HTTPException(
            status_code=400,
            detail="Institute attendance is available only for students, staff, HOD, and principal accounts",
        )
    return normalized


def is_configured_admin_user(user: models.User) -> bool:
    identifier = (getattr(user, "identifier", "") or "").strip().lower()
    return bool(identifier and identifier in CONFIGURED_ADMIN_IDENTIFIERS)


def get_effective_role(user: models.User) -> str:
    normalized = normalize_role(getattr(user, "role", None))
    if normalized == "admin":
        return normalized
    if is_configured_admin_user(user):
        return "admin"
    return normalized


def get_user_class_assignments(
    user: models.User,
    assignment_type: Optional[str] = None,
) -> list[models.StaffClassAssignment]:
    assignments = list(getattr(user, "class_assignments", []) or [])
    normalized_type = normalize_assignment_type(assignment_type)
    if normalized_type:
        assignments = [
            assignment
            for assignment in assignments
            if normalize_assignment_type(getattr(assignment, "assignment_type", None)) == normalized_type
        ]

    unique_assignments: dict[tuple[str, int, int, str], models.StaffClassAssignment] = {}
    for assignment in assignments:
        key = (
            (assignment.department or "").strip().lower(),
            int(assignment.year or 0),
            int(assignment.semester or 0),
            normalize_assignment_type(assignment.assignment_type),
        )
        unique_assignments[key] = assignment

    return sorted(
        unique_assignments.values(),
        key=lambda item: (
            item.department.lower(),
            item.year,
            item.semester,
            item.assignment_type.lower(),
        ),
    )


def get_primary_class_assignment(user: models.User) -> Optional[models.StaffClassAssignment]:
    advisor_assignments = get_user_class_assignments(user, "class_advisor")
    if advisor_assignments:
        return advisor_assignments[0]

    operator_assignments = get_user_class_assignments(user, "attendance_operator")
    if operator_assignments:
        return operator_assignments[0]

    return None


def format_scope_label(
    department: Optional[str],
    year: Optional[int] = None,
    semester: Optional[int] = None,
) -> str:
    parts = []
    if department:
        parts.append(department)
    if year:
        parts.append(f"Year {year}")
    if semester:
        parts.append(f"Sem {semester}")
    return " - ".join(parts) or "Assigned Scope"


def has_class_advisor_access(user: models.User) -> bool:
    role = get_effective_role(user)
    if role == "advisor":
        return True
    return bool(get_user_class_assignments(user, "class_advisor"))


def can_take_attendance(user: models.User) -> bool:
    role = get_effective_role(user)
    if role in {"admin", "hod", "advisor", "principal"}:
        return True
    if role == "staff":
        return has_class_advisor_access(user)
    return False


def get_user_scope_label(user: models.User) -> Optional[str]:
    role = get_effective_role(user)
    if role in {"hod", "advisor"}:
        return current_user_department if (current_user_department := (user.department or "").strip()) else "Faculty Scope"
    if role == "staff":
        assignment = get_primary_class_assignment(user)
        if assignment:
            return format_scope_label(
                assignment.department,
                assignment.year,
                assignment.semester,
            )
        return (user.department or "").strip() or "Assigned Scope"
    if role == "student":
        return format_scope_label(user.department, user.year, user.semester)
    return "College-wide"


def serialize_class_assignment(assignment: models.StaffClassAssignment) -> dict:
    return schemas.StaffClassAssignmentOut.model_validate(assignment).model_dump(mode="json")


def serialize_session_user(user: models.User) -> dict:
    payload = schemas.SessionUser.model_validate(user).model_dump(mode="json")
    payload["role"] = get_effective_role(user)
    payload["is_class_advisor"] = has_class_advisor_access(user)
    payload["can_take_attendance"] = can_take_attendance(user)
    payload["scope_label"] = get_user_scope_label(user)
    payload["class_assignments"] = [serialize_class_assignment(assignment) for assignment in get_user_class_assignments(user)]
    return payload


def require_roles(*roles: str):
    normalized_roles = {normalize_role(role) for role in roles}

    def role_dependency(current_user: models.User = Depends(auth.get_current_active_user)):
        if get_effective_role(current_user) not in normalized_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions for this action",
            )
        return current_user

    return role_dependency


def require_attendance_operator(current_user: models.User = Depends(auth.get_current_active_user)):
    if not can_take_attendance(current_user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient permissions for attendance operations",
        )
    return current_user


def require_faculty_dashboard_access(current_user: models.User = Depends(auth.get_current_active_user)):
    if get_effective_role(current_user) in {"hod", "advisor"} or has_class_advisor_access(current_user):
        return current_user
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Insufficient permissions for the faculty dashboard",
    )


def require_manual_override_access(current_user: models.User = Depends(auth.get_current_active_user)):
    if get_effective_role(current_user) in {"admin", "hod", "advisor", "principal"}:
        return current_user
    if get_effective_role(current_user) == "staff" and has_class_advisor_access(current_user):
        return current_user
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Insufficient permissions for manual attendance updates",
    )


def require_class_advisor_export_access(current_user: models.User = Depends(auth.get_current_active_user)):
    if get_effective_role(current_user) == "staff" and has_class_advisor_access(current_user):
        return current_user
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Insufficient permissions for class advisor student export",
    )


def ensure_settings(db: Session) -> models.Setting:
    settings = db.query(models.Setting).first()
    if settings:
        has_updates = False
        if settings.staff_morning_time_start is None:
            settings.staff_morning_time_start = settings.morning_time_start
            has_updates = True
        if settings.staff_morning_time_end is None:
            settings.staff_morning_time_end = settings.morning_time_end
            has_updates = True
        if settings.staff_evening_time_start is None:
            settings.staff_evening_time_start = settings.afternoon_time_start
            has_updates = True
        if settings.staff_evening_time_end is None:
            settings.staff_evening_time_end = settings.afternoon_time_end
            has_updates = True
        if has_updates:
            db.commit()
            db.refresh(settings)
        return settings

    settings = models.Setting(**DEFAULT_SETTINGS)
    db.add(settings)
    db.commit()
    db.refresh(settings)
    return settings


def serialize_calendar_rule(rule: models.CalendarRule) -> dict:
    return schemas.CalendarRuleOut.model_validate(rule).model_dump(mode="json")


def get_calendar_rules(db: Session) -> list[models.CalendarRule]:
    return (
        db.query(models.CalendarRule)
        .order_by(models.CalendarRule.start_date.asc(), models.CalendarRule.end_date.asc(), models.CalendarRule.id.asc())
        .all()
    )


def get_legacy_holiday_dates(settings: models.Setting) -> set[date]:
    holiday_dates: set[date] = set()
    for holiday in settings.holidays or []:
        if isinstance(holiday, date):
            holiday_dates.add(holiday)
            continue
        try:
            holiday_dates.add(date.fromisoformat(str(holiday)))
        except ValueError:
            continue
    return holiday_dates


def get_attendance_time_windows(settings: models.Setting, audience: str) -> dict:
    normalized_audience = validate_calendar_audience(audience)
    if normalized_audience == "students":
        return {
            "morning_start": settings.morning_time_start,
            "morning_end": settings.morning_time_end,
            "afternoon_start": settings.afternoon_time_start,
            "afternoon_end": settings.afternoon_time_end,
            "second_label": "Afternoon",
        }

    return {
        "morning_start": settings.staff_morning_time_start or settings.morning_time_start,
        "morning_end": settings.staff_morning_time_end or settings.morning_time_end,
        "afternoon_start": settings.staff_evening_time_start or settings.afternoon_time_start,
        "afternoon_end": settings.staff_evening_time_end or settings.afternoon_time_end,
        "second_label": "Evening",
    }


def build_session_defaults(settings: models.Setting, audience: str) -> dict:
    windows = get_attendance_time_windows(settings, audience)
    return {
        "morning": windows["morning_start"],
        "afternoon": windows["afternoon_start"],
    }


def serialize_settings(settings: models.Setting, calendar_rules: list[models.CalendarRule]) -> dict:
    holiday_dates = {
        holiday.isoformat() if isinstance(holiday, date) else str(holiday)
        for holiday in settings.holidays or []
    }
    holiday_dates.update(
        rule.start_date.isoformat()
        for rule in calendar_rules
        if normalize_calendar_day_type(rule.day_type) == "holiday"
        and normalize_calendar_audience(rule.audience) == "both"
        and rule.start_date == rule.end_date
    )

    return {
        "id": settings.id,
        "holidays": sorted(holiday_dates),
        "calendar_rules": [serialize_calendar_rule(rule) for rule in calendar_rules],
        "student_attendance": {
            "morning_time_start": settings.morning_time_start,
            "morning_time_end": settings.morning_time_end,
            "afternoon_time_start": settings.afternoon_time_start,
            "afternoon_time_end": settings.afternoon_time_end,
        },
        "staff_attendance": {
            "morning_time_start": settings.staff_morning_time_start or settings.morning_time_start,
            "morning_time_end": settings.staff_morning_time_end or settings.morning_time_end,
            "evening_time_start": settings.staff_evening_time_start or settings.afternoon_time_start,
            "evening_time_end": settings.staff_evening_time_end or settings.afternoon_time_end,
        },
    }


def get_attendance_calendar_audience_for_user(user: models.User) -> str:
    return "students" if get_effective_role(user) == "student" else "staff"


def resolve_calendar_day_type(
    target_date: date,
    audience: str,
    calendar_rules: list[models.CalendarRule],
    legacy_holiday_dates: Optional[set[date]] = None,
) -> tuple[str, Optional[models.CalendarRule]]:
    normalized_audience = validate_calendar_audience(audience)
    holiday_dates = legacy_holiday_dates or set()
    matching_rules = [
        rule
        for rule in calendar_rules
        if rule.start_date <= target_date <= rule.end_date
        and normalize_calendar_audience(rule.audience) in {normalized_audience, "both"}
    ]
    if matching_rules:
        matching_rules.sort(
            key=lambda rule: (
                1 if normalize_calendar_audience(rule.audience) == normalized_audience else 0,
                int(rule.id or 0),
            ),
            reverse=True,
        )
        selected_rule = matching_rules[0]
        return validate_calendar_day_type(selected_rule.day_type), selected_rule

    if target_date in holiday_dates:
        return "holiday", None

    if target_date.weekday() in WORKING_WEEKDAYS:
        return "working", None

    return "off_day", None


def get_working_dates(
    start_date: date,
    end_date: date,
    audience: str,
    calendar_rules: list[models.CalendarRule],
    legacy_holiday_dates: Optional[set[date]] = None,
) -> list[date]:
    current = start_date
    working_dates = []
    while current <= end_date:
        if is_working_day(current, audience, calendar_rules, legacy_holiday_dates):
            working_dates.append(current)
        current += timedelta(days=1)
    return working_dates


def is_attendance_display_day(
    target_date: date,
    audience: str,
    calendar_rules: list[models.CalendarRule],
    legacy_holiday_dates: Optional[set[date]] = None,
) -> bool:
    day_type, _ = resolve_calendar_day_type(target_date, audience, calendar_rules, legacy_holiday_dates)
    return day_type in VISIBLE_ATTENDANCE_DAY_TYPES


def get_attendance_display_dates(
    start_date: date,
    end_date: date,
    audience: str,
    calendar_rules: list[models.CalendarRule],
    legacy_holiday_dates: Optional[set[date]] = None,
) -> list[date]:
    current = start_date
    attendance_dates = []
    while current <= end_date:
        if is_attendance_display_day(current, audience, calendar_rules, legacy_holiday_dates):
            attendance_dates.append(current)
        current += timedelta(days=1)
    return attendance_dates


def resolve_date_range(
    days: Optional[int] = DEFAULT_DASHBOARD_DAYS,
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
) -> tuple[date, date]:
    today = get_current_date()
    resolved_days = days if days is not None else DEFAULT_DASHBOARD_DAYS

    if from_date is None and to_date is None:
        end_date = today
        start_date = end_date - timedelta(days=max(resolved_days - 1, 0))
    else:
        end_date = min(to_date or today, today)
        start_date = from_date or (end_date - timedelta(days=max(resolved_days - 1, 0)))

    if start_date > end_date:
        raise HTTPException(status_code=400, detail="From date must be earlier than or equal to To date")

    return start_date, end_date


def is_working_day(
    target_date: date,
    audience: str,
    calendar_rules: list[models.CalendarRule],
    legacy_holiday_dates: Optional[set[date]] = None,
) -> bool:
    day_type, _ = resolve_calendar_day_type(target_date, audience, calendar_rules, legacy_holiday_dates)
    return day_type == "working"


def get_session_end_time(session_name: str, settings: models.Setting, audience: str) -> dt_time:
    windows = get_attendance_time_windows(settings, audience)
    return windows["morning_end"] if session_name == "morning" else windows["afternoon_end"]


def format_display_time(value: dt_time) -> str:
    return value.strftime("%I:%M %p").lstrip("0")


def get_non_working_day_message(
    target_date: date,
    audience: str,
    calendar_rules: list[models.CalendarRule],
    legacy_holiday_dates: Optional[set[date]] = None,
) -> tuple[str, str]:
    day_type, matched_rule = resolve_calendar_day_type(target_date, audience, calendar_rules, legacy_holiday_dates)
    if day_type == "holiday":
        message = "No attendance scheduled today because it is marked as a holiday"
        if matched_rule and (matched_rule.reason or "").strip():
            message = f"{message}: {matched_rule.reason.strip()}"
        return "no_session", message
    if day_type == "attendance_not_conducted":
        message = "Attendance was not conducted today"
        if matched_rule and (matched_rule.reason or "").strip():
            message = f"{message}: {matched_rule.reason.strip()}"
        return "attendance_not_conducted", message
    return "no_session", f"No attendance scheduled today because {target_date.strftime('%A')} is an off day"


def resolve_active_attendance_window(
    current_datetime: datetime,
    settings: models.Setting,
    audience: str,
    calendar_rules: list[models.CalendarRule],
    legacy_holiday_dates: Optional[set[date]] = None,
) -> dict:
    current_date = current_datetime.date()
    current_time = current_datetime.time()
    windows = get_attendance_time_windows(settings, audience)

    if not is_working_day(current_date, audience, calendar_rules, legacy_holiday_dates):
        result_code, message = get_non_working_day_message(
            current_date,
            audience,
            calendar_rules,
            legacy_holiday_dates,
        )
        return {
            "result_code": result_code,
            "message": message,
            "session_name": None,
        }

    if current_time < windows["morning_start"]:
        return {
            "result_code": "before_window",
            "message": f"Morning attendance starts at {format_display_time(windows['morning_start'])}",
            "session_name": None,
        }

    if current_time <= windows["morning_end"]:
        return {
            "result_code": "open",
            "message": "Morning attendance is open",
            "session_name": "morning",
        }

    if current_time < windows["afternoon_start"]:
        return {
            "result_code": "between_sessions",
            "message": (
                f"Morning attendance closed. "
                f"{windows['second_label']} starts at {format_display_time(windows['afternoon_start'])}"
            ),
            "session_name": None,
        }

    if current_time <= windows["afternoon_end"]:
        return {
            "result_code": "open",
            "message": f"{windows['second_label']} attendance is open",
            "session_name": "afternoon",
        }

    return {
        "result_code": "day_closed",
        "message": "Today's attendance window is closed",
        "session_name": None,
    }


def serialize_attendance_window_status(window_status: dict) -> dict:
    return {
        "is_open": window_status["result_code"] == "open",
        "result_code": window_status["result_code"],
        "message": window_status["message"],
        "session_name": window_status["session_name"],
    }


def resolve_operator_attendance_window(
    current_datetime: datetime,
    settings: models.Setting,
    audiences: Iterable[str],
    calendar_rules: list[models.CalendarRule],
    legacy_holiday_dates: Optional[set[date]] = None,
) -> dict:
    normalized_audiences = sorted({validate_calendar_audience(audience) for audience in audiences}) or ["students"]
    audience_statuses = [
        {
            **resolve_active_attendance_window(
                current_datetime,
                settings,
                audience,
                calendar_rules,
                legacy_holiday_dates,
            ),
            "audience": audience,
        }
        for audience in normalized_audiences
    ]

    open_statuses = [status_item for status_item in audience_statuses if status_item["result_code"] == "open"]
    if len(open_statuses) > 1:
        return {
            "result_code": "open",
            "message": "Attendance is open",
            "session_name": open_statuses[0]["session_name"],
        }
    if open_statuses:
        return open_statuses[0]

    for result_code in ("between_sessions", "before_window", "day_closed", "attendance_not_conducted", "no_session"):
        matching_status = next(
            (status_item for status_item in audience_statuses if status_item["result_code"] == result_code),
            None,
        )
        if matching_status:
            return matching_status

    return audience_statuses[0]


def resolve_session_status(
    records: Iterable[models.Attendance],
    session_name: str,
    target_date: date,
    current_datetime: datetime,
    settings: models.Setting,
    audience: str,
    calendar_rules: list[models.CalendarRule],
    legacy_holiday_dates: Optional[set[date]] = None,
) -> str:
    day_type, _ = resolve_calendar_day_type(target_date, audience, calendar_rules, legacy_holiday_dates)
    if day_type == "holiday" or day_type == "off_day":
        return "no_session"
    if day_type == "attendance_not_conducted":
        return "attendance_not_conducted"

    session_records = [
        record
        for record in records
        if (record.session or "").strip().lower() == session_name
    ]
    if session_records:
        statuses = {normalize_status(record.status) for record in session_records}
        if "present" in statuses:
            return "present"
        if "late" in statuses:
            return "late"
        if "absent" in statuses:
            return "absent"

    today = current_datetime.date()
    if target_date < today:
        return "absent"
    if target_date > today:
        return "no_session"

    if current_datetime.time() <= get_session_end_time(session_name, settings, audience):
        return "pending"

    return "absent"


def resolve_overall_day_status(morning_status: str, afternoon_status: str) -> str:
    statuses = [normalize_status(morning_status), normalize_status(afternoon_status)]

    if all(status == "attendance_not_conducted" for status in statuses):
        return "attendance_not_conducted"
    if all(status in {"attendance_not_conducted", "no_session"} for status in statuses) and "attendance_not_conducted" in statuses:
        return "attendance_not_conducted"
    if all(status == "no_session" for status in statuses):
        return "no_session"
    if any(status == "pending" for status in statuses) and any(is_presentish(status) for status in statuses):
        return "partial"
    if any(is_presentish(status) for status in statuses):
        if all(is_presentish(status) for status in statuses if status not in NON_COUNTED_SESSION_STATUSES):
            if "late" in statuses and "present" not in statuses:
                return "late"
            return "present"
        return "partial"
    if any(status == "pending" for status in statuses):
        return "pending"
    return "absent"


def did_attend_day(morning_status: str, afternoon_status: str) -> bool:
    return is_presentish(morning_status) or is_presentish(afternoon_status)


def get_daily_total(morning_status: str, afternoon_status: str) -> float:
    total = 0.0
    if is_presentish(morning_status):
        total += 0.5
    if is_presentish(afternoon_status):
        total += 0.5
    return total


def is_presentish(status_value: str) -> bool:
    return normalize_status(status_value) in PRESENT_STATUSES


def build_student_attendance_metrics(
    records_by_date: dict[date, list[models.Attendance]],
    attendance_dates: list[date],
    working_dates: list[date],
    start_date: date,
    end_date: date,
    current_datetime: datetime,
    settings: models.Setting,
    audience: str,
    calendar_rules: list[models.CalendarRule],
    legacy_holiday_dates: Optional[set[date]] = None,
) -> dict:
    attendance_rows: list[dict] = []
    attended_sessions = 0
    absent_sessions = 0
    total_sessions = 0

    for attendance_day in attendance_dates:
        daily_records = records_by_date.get(attendance_day, [])
        morning_status = resolve_session_status(
            daily_records,
            "morning",
            attendance_day,
            current_datetime,
            settings,
            audience,
            calendar_rules,
            legacy_holiday_dates,
        )
        afternoon_status = resolve_session_status(
            daily_records,
            "afternoon",
            attendance_day,
            current_datetime,
            settings,
            audience,
            calendar_rules,
            legacy_holiday_dates,
        )
        overall_status = resolve_overall_day_status(morning_status, afternoon_status)
        daily_total = get_daily_total(morning_status, afternoon_status)

        for session_status in (morning_status, afternoon_status):
            normalized_status = normalize_status(session_status)
            if normalized_status in NON_COUNTED_SESSION_STATUSES:
                continue
            total_sessions += 1
            if is_presentish(normalized_status):
                attended_sessions += 1
            else:
                absent_sessions += 1

        attendance_rows.append(
            {
                "date": attendance_day.isoformat(),
                "morning_status": morning_status,
                "afternoon_status": afternoon_status,
                "overall_status": overall_status,
                "daily_total": daily_total,
                "status": overall_status,
                "sessions": sorted({record.session for record in daily_records}),
            }
        )

    current_streak = 0
    for row in reversed(attendance_rows):
        if did_attend_day(row["morning_status"], row["afternoon_status"]):
            current_streak += 1
        elif normalize_status(row["overall_status"]) in {"pending", "attendance_not_conducted", "no_session"}:
            continue
        else:
            break

    today = current_datetime.date()
    today_is_visible = start_date <= today <= end_date and is_attendance_display_day(
        today,
        audience,
        calendar_rules,
        legacy_holiday_dates,
    )
    if today_is_visible:
        today_records = records_by_date.get(today, [])
        today_morning_status = resolve_session_status(
            today_records,
            "morning",
            today,
            current_datetime,
            settings,
            audience,
            calendar_rules,
            legacy_holiday_dates,
        )
        today_afternoon_status = resolve_session_status(
            today_records,
            "afternoon",
            today,
            current_datetime,
            settings,
            audience,
            calendar_rules,
            legacy_holiday_dates,
        )
        today_status = resolve_overall_day_status(today_morning_status, today_afternoon_status)
        present_today = did_attend_day(today_morning_status, today_afternoon_status)
        today_daily_total = get_daily_total(today_morning_status, today_afternoon_status)
    else:
        today_morning_status = "no_session"
        today_afternoon_status = "no_session"
        today_status = "no_session"
        present_today = False
        today_daily_total = 0.0

    attendance_rate = round((attended_sessions / total_sessions) * 100, 1) if total_sessions else 0.0
    present_days = round(attended_sessions / 2, 1)
    absent_days = round(absent_sessions / 2, 1)
    ordered_rows = list(reversed(attendance_rows))

    return {
        "attendance_rate": attendance_rate,
        "present_days": present_days,
        "absent_days": absent_days,
        "total_working_days": len(working_dates),
        "attended_sessions": attended_sessions,
        "absent_sessions": absent_sessions,
        "total_sessions": total_sessions,
        "current_streak": current_streak,
        "present_today": present_today,
        "today_status": today_status,
        "today_morning_status": today_morning_status,
        "today_afternoon_status": today_afternoon_status,
        "today_daily_total": today_daily_total,
        "attendance_rows": ordered_rows,
        "daily_rows": ordered_rows,
    }


def build_class_scope_filters(
    current_user: models.User,
    user_model: type[models.User] = models.User,
) -> list:
    filters = []
    seen_scopes: set[tuple[str, int, int]] = set()
    for assignment in get_user_class_assignments(current_user):
        scope_key = (
            assignment.department.lower(),
            int(assignment.year),
            int(assignment.semester),
        )
        if scope_key in seen_scopes:
            continue
        seen_scopes.add(scope_key)
        filters.append(
            and_(
                user_model.department == assignment.department,
                user_model.year == assignment.year,
                user_model.semester == assignment.semester,
            )
        )
    return filters


def get_visible_users_query(db: Session, current_user: models.User):
    role = get_effective_role(current_user)
    query = db.query(models.User)
    if role in {"hod", "advisor"} and current_user.department:
        query = query.filter(models.User.department == current_user.department)
    elif role == "staff":
        scope_filters = build_class_scope_filters(current_user)
        if scope_filters:
            query = query.filter(func.lower(models.User.role) == "student").filter(or_(*scope_filters))
        else:
            query = query.filter(text("1 = 0"))
    elif role == "student":
        query = query.filter(models.User.id == current_user.id)
    return query


def get_attendance_operator_users_query(db: Session, current_user: models.User):
    role = get_effective_role(current_user)
    if role != "staff":
        return get_visible_users_query(db, current_user)

    scope_filters = build_class_scope_filters(current_user)
    query = db.query(models.User)
    if scope_filters:
        query = query.filter(or_(models.User.id == current_user.id, *scope_filters))
    else:
        query = query.filter(models.User.id == current_user.id)
    return query


def get_attendance_operator_audiences(db: Session, current_user: models.User) -> set[str]:
    role_rows = (
        get_attendance_operator_users_query(db, current_user)
        .with_entities(models.User.role)
        .distinct()
        .all()
    )
    audiences = {
        "students" if normalize_role(role_value) == "student" else "staff"
        for (role_value,) in role_rows
    }
    return audiences or {"students"}


def get_visible_attendance_query(db: Session, current_user: models.User):
    role = get_effective_role(current_user)
    query = db.query(models.Attendance).join(models.User)
    if role in {"hod", "advisor"} and current_user.department:
        query = query.filter(models.User.department == current_user.department)
    elif role == "staff":
        scope_filters = build_class_scope_filters(current_user)
        if scope_filters:
            query = query.filter(or_(*scope_filters))
        else:
            query = query.filter(text("1 = 0"))
    elif role == "student":
        query = query.filter(models.Attendance.user_id == current_user.id)
    return query


def serialize_attendance_log(attendance: models.Attendance) -> schemas.AttendanceLogOut:
    return schemas.AttendanceLogOut(
        id=attendance.id,
        user_id=attendance.user_id,
        user_name=attendance.user.name,
        identifier=attendance.user.identifier,
        department=attendance.user.department,
        date=attendance.date,
        time=attendance.time,
        session=attendance.session,
        status=attendance.status,
    )


def serialize_attendance_record(attendance: models.Attendance) -> schemas.AttendanceRecordOut:
    return schemas.AttendanceRecordOut(
        id=attendance.id,
        user_id=attendance.user_id,
        user_name=attendance.user.name,
        identifier=attendance.user.identifier,
        role=attendance.user.role,
        department=attendance.user.department,
        year=attendance.user.year,
        semester=attendance.user.semester,
        date=attendance.date,
        time=attendance.time,
        session=attendance.session,
        status=attendance.status,
    )


def build_student_summary_map(
    students: list[models.User],
    attendance_records: list[models.Attendance],
    settings: models.Setting,
    start_date: date,
    end_date: date,
    calendar_rules: list[models.CalendarRule],
    audience: str = "students",
):
    legacy_holiday_dates = get_legacy_holiday_dates(settings)
    attendance_dates = get_attendance_display_dates(start_date, end_date, audience, calendar_rules, legacy_holiday_dates)
    working_dates = get_working_dates(start_date, end_date, audience, calendar_rules, legacy_holiday_dates)
    records_by_user_date = group_attendance_records_by_user_date(attendance_records)
    current_datetime = get_current_datetime()

    summaries: dict[int, dict] = {}

    for student in students:
        user_records = records_by_user_date.get(student.id, {})
        summaries[student.id] = build_student_attendance_metrics(
            user_records,
            attendance_dates,
            working_dates,
            start_date,
            end_date,
            current_datetime,
            settings,
            audience,
            calendar_rules,
            legacy_holiday_dates,
        )

    return summaries


def group_attendance_records_by_user_date(
    attendance_records: Iterable[models.Attendance],
) -> dict[int, dict[date, list[models.Attendance]]]:
    records_by_user_date: dict[int, dict[date, list[models.Attendance]]] = defaultdict(lambda: defaultdict(list))
    for record in attendance_records:
        records_by_user_date[record.user_id][record.date].append(record)
    return records_by_user_date


def build_faculty_student_rows(
    students: list[models.User],
    summaries: dict[int, dict],
) -> list[dict]:
    items = []
    for student in students:
        items.append(
            {
                "user_id": student.id,
                "name": student.name,
                "identifier": student.identifier,
                "department": student.department,
                "year": student.year,
                "semester": student.semester,
                "attendance_rate": summaries.get(student.id, {}).get("attendance_rate", 0.0),
            }
        )
    return items


def build_class_daily_attendance_rows(
    students: list[models.User],
    summaries: dict[int, dict],
    records_by_user_date: dict[int, dict[date, list[models.Attendance]]],
    target_date: date,
    current_datetime: datetime,
    settings: models.Setting,
    audience: str,
    calendar_rules: list[models.CalendarRule],
    legacy_holiday_dates: Optional[set[date]] = None,
) -> list[dict]:
    rows: list[dict] = []
    for student in students:
        daily_records = records_by_user_date.get(student.id, {}).get(target_date, [])
        morning_status = resolve_session_status(
            daily_records,
            "morning",
            target_date,
            current_datetime,
            settings,
            audience,
            calendar_rules,
            legacy_holiday_dates,
        )
        afternoon_status = resolve_session_status(
            daily_records,
            "afternoon",
            target_date,
            current_datetime,
            settings,
            audience,
            calendar_rules,
            legacy_holiday_dates,
        )
        rows.append(
            {
                "user_id": student.id,
                "name": student.name,
                "identifier": student.identifier,
                "department": student.department,
                "year": student.year,
                "semester": student.semester,
                "morning_status": morning_status,
                "afternoon_status": afternoon_status,
                "daily_total": get_daily_total(morning_status, afternoon_status),
                "attendance_rate": summaries.get(student.id, {}).get("attendance_rate", 0.0),
            }
        )
    return rows


def build_staff_scope_warning(
    db: Session,
    current_user: models.User,
    total_students: int,
) -> Optional[str]:
    if get_effective_role(current_user) != "staff" or total_students:
        return None

    assignment = get_primary_class_assignment(current_user)
    if not assignment:
        return "Class advisor access is enabled, but no class scope is assigned to this account."

    matching_semesters = (
        db.query(models.User.semester, func.count(models.User.id))
        .filter(
            func.lower(models.User.role) == "student",
            models.User.department == assignment.department,
            models.User.year == assignment.year,
        )
        .group_by(models.User.semester)
        .order_by(models.User.semester.asc())
        .all()
    )
    if matching_semesters:
        semester_summary = ", ".join(
            f"Sem {semester} ({count})"
            for semester, count in matching_semesters
            if semester is not None
        )
        if semester_summary:
            return (
                f"No students match {assignment.department} / Year {assignment.year} / Sem {assignment.semester}. "
                f"Available student records for this department and year: {semester_summary}."
            )

    department_count = (
        db.query(func.count(models.User.id))
        .filter(
            func.lower(models.User.role) == "student",
            models.User.department == assignment.department,
        )
        .scalar()
        or 0
    )
    if department_count:
        return (
            f"No students match {assignment.department} / Year {assignment.year} / Sem {assignment.semester}. "
            f"There are {department_count} student record(s) in this department, but none in the assigned year and semester."
        )

    return (
        f"No students currently match {assignment.department} / Year {assignment.year} / Sem {assignment.semester}. "
        "Update the class advisor scope or the student records if this class should appear here."
    )


def summarize_faculty_session(rows: list[dict], session_key: str) -> dict:
    summary = {
        "present": 0,
        "absent": 0,
        "pending": 0,
        "no_session": 0,
    }

    for row in rows:
        status_value = normalize_status(row.get(session_key))
        if is_presentish(status_value):
            summary["present"] += 1
        elif status_value == "absent":
            summary["absent"] += 1
        elif status_value == "pending":
            summary["pending"] += 1
        else:
            summary["no_session"] += 1

    return summary


def get_scope_attendance_history_start(db: Session, student_ids: list[int]) -> date:
    if not student_ids:
        return get_current_date()

    earliest_attendance_date = (
        db.query(func.min(models.Attendance.date))
        .filter(models.Attendance.user_id.in_(student_ids))
        .scalar()
    )
    return earliest_attendance_date or get_current_date()


def build_faculty_dashboard_payload(
    db: Session,
    current_user: models.User,
    selected_date: Optional[date] = None,
) -> dict:
    settings = ensure_settings(db)
    calendar_rules = get_calendar_rules(db)
    legacy_holiday_dates = get_legacy_holiday_dates(settings)
    students = (
        get_visible_users_query(db, current_user)
        .filter(func.lower(models.User.role) == "student")
        .order_by(models.User.name.asc())
        .all()
    )
    student_ids = [student.id for student in students]
    today = get_current_date()
    history_start = get_scope_attendance_history_start(db, student_ids)
    target_date = min(max(selected_date or today, history_start), today)

    attendance_records: list[models.Attendance] = []
    if student_ids:
        attendance_records = (
            db.query(models.Attendance)
            .filter(
                models.Attendance.user_id.in_(student_ids),
                models.Attendance.date >= history_start,
                models.Attendance.date <= today,
            )
            .all()
        )

    current_datetime = get_current_datetime()
    summaries = build_student_summary_map(students, attendance_records, settings, history_start, today, calendar_rules, "students")
    records_by_user_date = group_attendance_records_by_user_date(attendance_records)
    today_rows = build_class_daily_attendance_rows(
        students,
        summaries,
        records_by_user_date,
        today,
        current_datetime,
        settings,
        "students",
        calendar_rules,
        legacy_holiday_dates,
    )
    target_rows = build_class_daily_attendance_rows(
        students,
        summaries,
        records_by_user_date,
        target_date,
        current_datetime,
        settings,
        "students",
        calendar_rules,
        legacy_holiday_dates,
    )

    today_is_working_day = is_working_day(today, "students", calendar_rules, legacy_holiday_dates)
    if today_is_working_day:
        today_present_count = sum(
            1
            for row in today_rows
            if did_attend_day(row["morning_status"], row["afternoon_status"])
        )
        today_absent_count = max(len(today_rows) - today_present_count, 0)
    else:
        today_present_count = 0
        today_absent_count = 0

    student_rows = build_faculty_student_rows(students, summaries)
    low_attendance = sorted(
        [item for item in student_rows if item["attendance_rate"] < 75],
        key=lambda item: (item["attendance_rate"], item["name"].lower()),
    )
    class_attendance_rate = round(
        sum(item["attendance_rate"] for item in student_rows) / len(student_rows),
        1,
    ) if student_rows else 0.0

    current_role = get_effective_role(current_user)
    scope_label = get_user_scope_label(current_user) if current_role in {"hod", "advisor", "staff"} else "Faculty Scope"
    scope_warning = build_staff_scope_warning(db, current_user, len(students))

    return {
        "scope_label": scope_label,
        "scope_warning": scope_warning,
        "history_start": history_start.isoformat(),
        "selected_date": target_date.isoformat(),
        "selected_date_is_working_day": is_working_day(target_date, "students", calendar_rules, legacy_holiday_dates),
        "today_is_working_day": today_is_working_day,
        "total_students": len(students),
        "today_present_count": today_present_count,
        "today_absent_count": today_absent_count,
        "attendance_rate": class_attendance_rate,
        "today_status": {
            "morning": summarize_faculty_session(today_rows, "morning_status"),
            "afternoon": summarize_faculty_session(today_rows, "afternoon_status"),
        },
        "low_attendance": low_attendance,
        "students": student_rows,
        "daily_attendance": target_rows,
        "session_defaults": build_session_defaults(settings, "students"),
    }


def build_faculty_attendance_export(
    db: Session,
    current_user: models.User,
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
) -> tuple[bytes, str]:
    settings = ensure_settings(db)
    calendar_rules = get_calendar_rules(db)
    legacy_holiday_dates = get_legacy_holiday_dates(settings)
    students = (
        get_visible_users_query(db, current_user)
        .filter(func.lower(models.User.role) == "student")
        .order_by(models.User.name.asc())
        .all()
    )
    student_ids = [student.id for student in students]
    today = get_current_date()
    history_start = get_scope_attendance_history_start(db, student_ids)

    resolved_end_date = min(to_date or from_date or today, today)
    resolved_start_date = max(from_date or resolved_end_date, history_start)

    if resolved_start_date > resolved_end_date:
        raise HTTPException(status_code=400, detail="From date must be earlier than or equal to To date")

    attendance_records: list[models.Attendance] = []
    if student_ids:
        attendance_records = (
            db.query(models.Attendance)
            .filter(
                models.Attendance.user_id.in_(student_ids),
                models.Attendance.date >= resolved_start_date,
                models.Attendance.date <= resolved_end_date,
            )
            .all()
        )

    records_by_user_date = group_attendance_records_by_user_date(attendance_records)
    current_datetime = get_current_datetime()
    workbook_rows: list[list[object]] = [[
        "Date",
        "Register Number",
        "Student Name",
        "Year",
        "Semester",
        "Morning Status",
        "Afternoon Status",
        "Daily Total",
    ]]

    for attendance_day in get_attendance_display_dates(resolved_start_date, resolved_end_date, "students", calendar_rules, legacy_holiday_dates):
        daily_rows = build_class_daily_attendance_rows(
            students,
            {},
            records_by_user_date,
            attendance_day,
            current_datetime,
            settings,
            "students",
            calendar_rules,
            legacy_holiday_dates,
        )
        for row in daily_rows:
            workbook_rows.append(
                [
                    attendance_day.isoformat(),
                    row["identifier"],
                    row["name"],
                    row.get("year"),
                    row.get("semester"),
                    row["morning_status"],
                    row["afternoon_status"],
                    row["daily_total"],
                ]
            )

    workbook_bytes = build_excel_workbook_bytes("Attendance", workbook_rows)
    scope_label = (get_user_scope_label(current_user) or "faculty_scope").replace(" ", "_").replace("/", "_").lower()
    filename = f"{scope_label}_attendance_{resolved_start_date}_to_{resolved_end_date}.xlsx"
    return workbook_bytes, filename


def build_class_advisor_student_export(
    db: Session,
    current_user: models.User,
) -> tuple[bytes, str]:
    students = (
        get_visible_users_query(db, current_user)
        .filter(func.lower(models.User.role) == "student")
        .order_by(models.User.name.asc(), models.User.identifier.asc())
        .all()
    )

    workbook_rows: list[list[object]] = [[
        "Student Name",
        "Register Number",
        "Department",
        "Year",
        "Semester",
        "Date Of Birth",
        "Blood Group",
        "Phone Number",
        "Parent Phone Number",
        "Address",
    ]]

    for student in students:
        workbook_rows.append(
            [
                student.name,
                student.identifier,
                student.department,
                student.year,
                student.semester,
                student.dob.isoformat() if student.dob else "",
                student.blood_group,
                student.phone_number,
                student.parent_phone_number,
                student.address,
            ]
        )

    workbook_bytes = build_excel_workbook_bytes("Students", workbook_rows)
    assignment = get_primary_class_assignment(current_user)
    scope_label = format_scope_label(
        assignment.department if assignment else current_user.department,
        assignment.year if assignment else None,
        assignment.semester if assignment else None,
    )
    filename = (
        f"{scope_label.replace(' ', '_').replace('/', '_').replace('-', '_').lower()}_student_data.xlsx"
        if scope_label
        else "class_student_data.xlsx"
    )
    return workbook_bytes, filename


def build_admin_role_user_data_export(
    db: Session,
    current_user: models.User,
    target_role: str,
    *,
    search: str = "",
    department: str = "",
    year: Optional[int] = None,
    semester: Optional[int] = None,
) -> tuple[bytes, str]:
    normalized_role = validate_institute_attendance_role(target_role)
    normalized_department = (
        validate_department_name(department, required=False)
        if department.strip()
        else None
    )

    query = (
        get_visible_users_query(db, current_user)
        .filter(func.lower(models.User.role) == normalized_role)
    )

    if normalized_department:
        query = query.filter(models.User.department == normalized_department)

    if search.strip():
        search_term = f"%{search.strip()}%"
        query = query.filter(
            or_(
                models.User.name.ilike(search_term),
                models.User.identifier.ilike(search_term),
            )
        )

    if normalized_role == "student":
        if year is not None:
            query = query.filter(models.User.year == year)
        if semester is not None:
            query = query.filter(models.User.semester == semester)

    users = query.order_by(models.User.name.asc(), models.User.identifier.asc()).all()

    if normalized_role == "student":
        workbook_rows: list[list[object]] = [[
            "Student Name",
            "Register Number",
            "Department",
            "Year",
            "Semester",
            "Date Of Birth",
            "Blood Group",
            "Phone Number",
            "Parent Phone Number",
            "Address",
        ]]

        for user in users:
            workbook_rows.append(
                [
                    user.name,
                    user.identifier,
                    user.department,
                    user.year,
                    user.semester,
                    user.dob.isoformat() if user.dob else "",
                    user.blood_group,
                    user.phone_number,
                    user.parent_phone_number,
                    user.address,
                ]
            )
    elif normalized_role == "staff":
        workbook_rows = [[
            "Staff Name",
            "Identifier",
            "Department",
            "Phone Number",
            "Blood Group",
            "Address",
            "Class Advisor Access",
            "Scope",
            "Assignments",
        ]]

        for user in users:
            assignments = [
                f"{format_scope_label(assignment.department, assignment.year, assignment.semester)}"
                f" ({(assignment.assignment_type or '').replace('_', ' ').title()})"
                for assignment in get_user_class_assignments(user)
            ]
            workbook_rows.append(
                [
                    user.name,
                    user.identifier,
                    user.department,
                    user.phone_number,
                    user.blood_group,
                    user.address,
                    "Yes" if has_class_advisor_access(user) else "No",
                    get_user_scope_label(user),
                    ", ".join(assignments),
                ]
            )
    else:
        title_label = "HOD" if normalized_role == "hod" else "Principal"
        workbook_rows = [[
            f"{title_label} Name",
            "Identifier",
            "Department",
            "Phone Number",
            "Blood Group",
            "Address",
            "Scope",
        ]]

        for user in users:
            workbook_rows.append(
                [
                    user.name,
                    user.identifier,
                    user.department,
                    user.phone_number,
                    user.blood_group,
                    user.address,
                    get_user_scope_label(user),
                ]
            )

    sheet_name = {
        "student": "Students",
        "staff": "Staff",
        "hod": "HODs",
        "principal": "Principals",
    }[normalized_role]
    workbook_bytes = build_excel_workbook_bytes(sheet_name, workbook_rows)

    filename_parts = [
        slugify_export_segment(department, "institute"),
        normalized_role,
        "data",
    ]
    if normalized_role == "student" and year is not None:
        filename_parts.append(f"year_{year}")
    if normalized_role == "student" and semester is not None:
        filename_parts.append(f"semester_{semester}")
    filename = f"{'_'.join(filename_parts)}.xlsx"
    return workbook_bytes, filename


def build_department_student_daily_attendance(
    db: Session,
    current_user: models.User,
    year: Optional[int] = None,
    semester: Optional[int] = None,
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
) -> list[dict]:
    if not (current_user.department or "").strip():
        raise HTTPException(status_code=400, detail="Department is required for HOD attendance scope")

    settings = ensure_settings(db)
    calendar_rules = get_calendar_rules(db)
    legacy_holiday_dates = get_legacy_holiday_dates(settings)
    start_date, end_date = resolve_date_range(
        days=DEFAULT_DASHBOARD_DAYS,
        from_date=from_date,
        to_date=to_date,
    )

    student_query = (
        get_visible_users_query(db, current_user)
        .filter(func.lower(models.User.role) == "student")
    )
    if year is not None:
        student_query = student_query.filter(models.User.year == year)
    if semester is not None:
        student_query = student_query.filter(models.User.semester == semester)

    students = student_query.order_by(models.User.name.asc(), models.User.identifier.asc()).all()
    student_ids = [student.id for student in students]
    attendance_records: list[models.Attendance] = []
    if student_ids:
        attendance_records = (
            db.query(models.Attendance)
            .filter(
                models.Attendance.user_id.in_(student_ids),
                models.Attendance.date >= start_date,
                models.Attendance.date <= end_date,
            )
            .all()
        )

    summaries = build_student_summary_map(
        students,
        attendance_records,
        settings,
        start_date,
        end_date,
        calendar_rules,
        "students",
    )
    records_by_user_date = group_attendance_records_by_user_date(attendance_records)
    current_datetime = get_current_datetime()
    items: list[dict] = []
    attendance_dates = list(reversed(
        get_attendance_display_dates(
            start_date,
            end_date,
            "students",
            calendar_rules,
            legacy_holiday_dates,
        )
    ))

    for attendance_day in attendance_dates:
        daily_rows = build_class_daily_attendance_rows(
            students,
            summaries,
            records_by_user_date,
            attendance_day,
            current_datetime,
            settings,
            "students",
            calendar_rules,
            legacy_holiday_dates,
        )
        working_day = is_working_day(attendance_day, "students", calendar_rules, legacy_holiday_dates)
        for row in daily_rows:
            items.append(
                {
                    "user_id": row["user_id"],
                    "name": row["name"],
                    "identifier": row["identifier"],
                    "role": "student",
                    "department": current_user.department,
                    "year": row.get("year"),
                    "semester": row.get("semester"),
                    "date": attendance_day,
                    "morning_status": row["morning_status"],
                    "afternoon_status": row["afternoon_status"],
                    "daily_total": row["daily_total"],
                    "attendance_rate": row.get("attendance_rate", 0.0),
                    "is_working_day": working_day,
                }
            )

    return items


def build_department_staff_daily_attendance(
    db: Session,
    current_user: models.User,
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
) -> list[dict]:
    if not (current_user.department or "").strip():
        raise HTTPException(status_code=400, detail="Department is required for HOD attendance scope")

    settings = ensure_settings(db)
    calendar_rules = get_calendar_rules(db)
    legacy_holiday_dates = get_legacy_holiday_dates(settings)
    start_date, end_date = resolve_date_range(
        days=DEFAULT_DASHBOARD_DAYS,
        from_date=from_date,
        to_date=to_date,
    )

    staff_members = (
        get_visible_users_query(db, current_user)
        .filter(func.lower(models.User.role) == "staff")
        .order_by(models.User.name.asc(), models.User.identifier.asc())
        .all()
    )
    staff_ids = [staff_user.id for staff_user in staff_members]
    attendance_records: list[models.Attendance] = []
    if staff_ids:
        attendance_records = (
            db.query(models.Attendance)
            .filter(
                models.Attendance.user_id.in_(staff_ids),
                models.Attendance.date >= start_date,
                models.Attendance.date <= end_date,
            )
            .all()
        )

    records_by_user_date = group_attendance_records_by_user_date(attendance_records)
    current_datetime = get_current_datetime()
    items: list[dict] = []
    attendance_dates = list(reversed(
        get_attendance_display_dates(
            start_date,
            end_date,
            "staff",
            calendar_rules,
            legacy_holiday_dates,
        )
    ))

    for attendance_day in attendance_dates:
        working_day = is_working_day(attendance_day, "staff", calendar_rules, legacy_holiday_dates)
        for staff_user in staff_members:
            daily_records = records_by_user_date.get(staff_user.id, {}).get(attendance_day, [])
            morning_status = resolve_session_status(
                daily_records,
                "morning",
                attendance_day,
                current_datetime,
                settings,
                "staff",
                calendar_rules,
                legacy_holiday_dates,
            )
            afternoon_status = resolve_session_status(
                daily_records,
                "afternoon",
                attendance_day,
                current_datetime,
                settings,
                "staff",
                calendar_rules,
                legacy_holiday_dates,
            )
            items.append(
                {
                    "user_id": staff_user.id,
                    "name": staff_user.name,
                    "identifier": staff_user.identifier,
                    "role": "staff",
                    "department": staff_user.department,
                    "year": None,
                    "semester": None,
                    "date": attendance_day,
                    "morning_status": morning_status,
                    "afternoon_status": afternoon_status,
                    "daily_total": get_daily_total(morning_status, afternoon_status),
                    "attendance_rate": None,
                    "is_working_day": working_day,
                }
            )

    return items


def build_department_student_attendance_export(
    db: Session,
    current_user: models.User,
    year: Optional[int] = None,
    semester: Optional[int] = None,
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
) -> tuple[bytes, str]:
    items = build_department_student_daily_attendance(
        db,
        current_user,
        year=year,
        semester=semester,
        from_date=from_date,
        to_date=to_date,
    )
    workbook_rows: list[list[object]] = [[
        "Date",
        "Register Number",
        "Student Name",
        "Year",
        "Semester",
        "Morning Status",
        "Afternoon Status",
        "Daily Total",
        "Attendance Percentage",
    ]]

    for item in items:
        workbook_rows.append(
            [
                item["date"].isoformat() if isinstance(item["date"], date) else str(item["date"]),
                item["identifier"],
                item["name"],
                item.get("year"),
                item.get("semester"),
                item["morning_status"],
                item["afternoon_status"],
                item["daily_total"],
                item.get("attendance_rate"),
            ]
        )

    workbook_bytes = build_excel_workbook_bytes("Student Attendance", workbook_rows)
    filename = (
        f"{(current_user.department or 'department').replace(' ', '_').replace('/', '_').replace('-', '_').lower()}"
        "_student_attendance.xlsx"
    )
    return workbook_bytes, filename


def build_department_staff_attendance_export(
    db: Session,
    current_user: models.User,
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
) -> tuple[bytes, str]:
    items = build_department_staff_daily_attendance(
        db,
        current_user,
        from_date=from_date,
        to_date=to_date,
    )
    workbook_rows: list[list[object]] = [[
        "Date",
        "Staff Identifier",
        "Staff Name",
        "Morning Status",
        "Evening Status",
        "Daily Total",
    ]]

    for item in items:
        workbook_rows.append(
            [
                item["date"].isoformat() if isinstance(item["date"], date) else str(item["date"]),
                item["identifier"],
                item["name"],
                item["morning_status"],
                item["afternoon_status"],
                item["daily_total"],
            ]
        )

    workbook_bytes = build_excel_workbook_bytes("Staff Attendance", workbook_rows)
    filename = (
        f"{(current_user.department or 'department').replace(' ', '_').replace('/', '_').replace('-', '_').lower()}"
        "_staff_attendance.xlsx"
    )
    return workbook_bytes, filename


def slugify_export_segment(value: Optional[object], fallback: str) -> str:
    normalized = str(value or "").strip().lower()
    if not normalized:
        normalized = fallback
    return normalized.replace(" ", "_").replace("/", "_").replace("-", "_")


def build_institute_role_daily_attendance(
    db: Session,
    current_user: models.User,
    target_role: str,
    audience: str,
    *,
    department: str = "",
    year: Optional[int] = None,
    semester: Optional[int] = None,
    search: str = "",
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
) -> list[dict]:
    normalized_role = validate_institute_attendance_role(target_role)
    normalized_audience = validate_calendar_audience(audience)
    normalized_department = (
        validate_department_name(department, required=False)
        if department.strip()
        else None
    )

    if normalized_role == "student" and normalized_audience != "students":
        raise HTTPException(status_code=400, detail="Student attendance must use the student attendance calendar")
    if normalized_role != "student" and normalized_audience != "staff":
        raise HTTPException(status_code=400, detail="Staff attendance must use the staff attendance calendar")

    settings = ensure_settings(db)
    calendar_rules = get_calendar_rules(db)
    legacy_holiday_dates = get_legacy_holiday_dates(settings)
    start_date, end_date = resolve_date_range(
        days=DEFAULT_DASHBOARD_DAYS,
        from_date=from_date,
        to_date=to_date,
    )

    query = (
        get_visible_users_query(db, current_user)
        .filter(func.lower(models.User.role) == normalized_role)
    )
    if normalized_department:
        query = query.filter(models.User.department == normalized_department)
    if search.strip():
        search_term = f"%{search.strip()}%"
        query = query.filter(
            or_(
                models.User.name.ilike(search_term),
                models.User.identifier.ilike(search_term),
            )
        )
    if normalized_role == "student":
        if year is not None:
            query = query.filter(models.User.year == year)
        if semester is not None:
            query = query.filter(models.User.semester == semester)

    users = query.order_by(models.User.name.asc(), models.User.identifier.asc()).all()
    user_ids = [user.id for user in users]
    attendance_records: list[models.Attendance] = []
    if user_ids:
        attendance_records = (
            db.query(models.Attendance)
            .filter(
                models.Attendance.user_id.in_(user_ids),
                models.Attendance.date >= start_date,
                models.Attendance.date <= end_date,
            )
            .all()
        )

    summaries = (
        build_student_summary_map(
            users,
            attendance_records,
            settings,
            start_date,
            end_date,
            calendar_rules,
            normalized_audience,
        )
        if normalized_role == "student"
        else {}
    )
    records_by_user_date = group_attendance_records_by_user_date(attendance_records)
    current_datetime = get_current_datetime()
    items: list[dict] = []
    attendance_dates = list(reversed(
        get_attendance_display_dates(
            start_date,
            end_date,
            normalized_audience,
            calendar_rules,
            legacy_holiday_dates,
        )
    ))

    for attendance_day in attendance_dates:
        daily_rows = build_class_daily_attendance_rows(
            users,
            summaries,
            records_by_user_date,
            attendance_day,
            current_datetime,
            settings,
            normalized_audience,
            calendar_rules,
            legacy_holiday_dates,
        )
        working_day = is_working_day(attendance_day, normalized_audience, calendar_rules, legacy_holiday_dates)
        for row in daily_rows:
            items.append(
                {
                    "user_id": row["user_id"],
                    "name": row["name"],
                    "identifier": row["identifier"],
                    "role": normalized_role,
                    "department": row.get("department"),
                    "year": row.get("year"),
                    "semester": row.get("semester"),
                    "date": attendance_day,
                    "morning_status": row["morning_status"],
                    "afternoon_status": row["afternoon_status"],
                    "daily_total": row["daily_total"],
                    "attendance_rate": row.get("attendance_rate") if normalized_role == "student" else None,
                    "is_working_day": working_day,
                }
            )

    return items


def build_institute_role_attendance_export(
    db: Session,
    current_user: models.User,
    target_role: str,
    audience: str,
    *,
    department: str = "",
    year: Optional[int] = None,
    semester: Optional[int] = None,
    search: str = "",
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
) -> tuple[bytes, str]:
    normalized_role = validate_institute_attendance_role(target_role)
    items = build_institute_role_daily_attendance(
        db,
        current_user,
        target_role=normalized_role,
        audience=audience,
        department=department,
        year=year,
        semester=semester,
        search=search,
        from_date=from_date,
        to_date=to_date,
    )

    if normalized_role == "student":
        workbook_rows: list[list[object]] = [[
            "Date",
            "Register Number",
            "Student Name",
            "Department",
            "Year",
            "Semester",
            "Morning Status",
            "Afternoon Status",
            "Daily Total",
            "Attendance Percentage",
        ]]
        for item in items:
            workbook_rows.append(
                [
                    item["date"].isoformat() if isinstance(item["date"], date) else str(item["date"]),
                    item["identifier"],
                    item["name"],
                    item.get("department"),
                    item.get("year"),
                    item.get("semester"),
                    item["morning_status"],
                    item["afternoon_status"],
                    item["daily_total"],
                    item.get("attendance_rate"),
                ]
            )
    else:
        role_name_label = {
            "staff": "Staff Name",
            "hod": "HOD Name",
            "principal": "Principal Name",
        }.get(normalized_role, "User Name")
        workbook_rows = [[
            "Date",
            "Identifier",
            role_name_label,
            "Department",
            "Morning Status",
            "Evening Status",
            "Daily Total",
        ]]
        for item in items:
            workbook_rows.append(
                [
                    item["date"].isoformat() if isinstance(item["date"], date) else str(item["date"]),
                    item["identifier"],
                    item["name"],
                    item.get("department"),
                    item["morning_status"],
                    item["afternoon_status"],
                    item["daily_total"],
                ]
            )

    workbook_title = f"{normalized_role.title()} Attendance"
    workbook_bytes = build_excel_workbook_bytes(workbook_title, workbook_rows)
    filename_parts = [
        slugify_export_segment(department, "institute"),
        normalized_role,
        "attendance",
    ]
    if normalized_role == "student" and year is not None:
        filename_parts.append(f"year_{year}")
    if normalized_role == "student" and semester is not None:
        filename_parts.append(f"semester_{semester}")
    filename = f"{'_'.join(filename_parts)}.xlsx"
    return workbook_bytes, filename


def build_principal_role_daily_attendance(
    db: Session,
    current_user: models.User,
    target_role: str,
    audience: str,
    department: str = "",
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
) -> list[dict]:
    return build_institute_role_daily_attendance(
        db,
        current_user,
        target_role=target_role,
        audience=audience,
        department=department,
        from_date=from_date,
        to_date=to_date,
    )


def build_principal_student_attendance_export(
    db: Session,
    current_user: models.User,
    department: str = "",
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
) -> tuple[bytes, str]:
    return build_institute_role_attendance_export(
        db,
        current_user,
        target_role="student",
        audience="students",
        department=department,
        from_date=from_date,
        to_date=to_date,
    )


def build_comparison_items(groups: dict[str, list[dict]], item_label: str = "students") -> list[dict]:
    comparison = []
    for label, items in groups.items():
        if not items:
            continue
        student_total = len(items)
        avg_rate = round(sum(item["attendance_rate"] for item in items) / student_total, 1)
        present_today = sum(1 for item in items if item["present_today"])
        comparison.append(
            {
                "label": label,
                "value": avg_rate,
                "meta": f"{present_today}/{student_total} {item_label} present today",
            }
        )

    comparison.sort(key=lambda item: item["value"], reverse=True)
    return comparison


def build_trend_data(
    students: list[models.User],
    summaries: dict[int, dict],
    settings: models.Setting,
    start_date: date,
    end_date: date,
    calendar_rules: list[models.CalendarRule],
) -> list[dict]:
    legacy_holiday_dates = get_legacy_holiday_dates(settings)
    working_dates = get_working_dates(start_date, end_date, "students", calendar_rules, legacy_holiday_dates)
    if not students or not working_dates:
        return []

    student_ids = [student.id for student in students]
    trend_rows = []
    for working_day in working_dates[-7:]:
        attended_sessions = 0
        counted_sessions = 0
        for student_id in student_ids:
            daily_rows = summaries.get(student_id, {}).get("daily_rows", [])
            row = next((item for item in daily_rows if item["date"] == working_day.isoformat()), None)
            if not row:
                continue
            for session_status in (row.get("morning_status"), row.get("afternoon_status")):
                normalized_status = normalize_status(session_status)
                if normalized_status in NON_COUNTED_SESSION_STATUSES:
                    continue
                counted_sessions += 1
                if is_presentish(normalized_status):
                    attended_sessions += 1
        rate = round((attended_sessions / counted_sessions) * 100, 1) if counted_sessions else 0.0
        trend_rows.append({"label": working_day.strftime("%d %b"), "value": rate})
    return trend_rows


def build_scope_overview(db: Session, current_user: models.User, days: int = DEFAULT_DASHBOARD_DAYS) -> dict:
    settings = ensure_settings(db)
    calendar_rules = get_calendar_rules(db)
    end_date = get_current_date()
    start_date = end_date - timedelta(days=max(days - 1, 0))

    visible_users = get_visible_users_query(db, current_user).order_by(models.User.name.asc()).all()
    students = [user for user in visible_users if normalize_role(user.role) == "student"]
    student_ids = [student.id for student in students]
    attendance_records = []
    if student_ids:
        attendance_records = (
            db.query(models.Attendance)
            .filter(
                models.Attendance.user_id.in_(student_ids),
                models.Attendance.date >= start_date,
                models.Attendance.date <= end_date,
            )
            .all()
        )

    summaries = build_student_summary_map(students, attendance_records, settings, start_date, end_date, calendar_rules, "students")
    student_cards = list(summaries.values())
    present_today = sum(1 for item in student_cards if item["present_today"])
    average_attendance = round(
        sum(item["attendance_rate"] for item in student_cards) / len(student_cards),
        1,
    ) if student_cards else 0.0

    recent_attendance = (
        get_visible_attendance_query(db, current_user)
        .options(joinedload(models.Attendance.user))
        .order_by(models.Attendance.date.desc(), models.Attendance.time.desc())
        .limit(8)
        .all()
    )

    role_distribution = Counter(normalize_role(user.role) for user in visible_users)
    role_breakdown = [
        {"label": role.title(), "value": count, "meta": "Users"}
        for role, count in sorted(role_distribution.items())
    ]

    department_groups: dict[str, list[dict]] = defaultdict(list)
    year_groups: dict[str, list[dict]] = defaultdict(list)
    for student in students:
        summary = summaries.get(student.id, {})
        summary_row = {
            "attendance_rate": summary.get("attendance_rate", 0.0),
            "present_today": summary.get("present_today", False),
        }
        department_groups[student.department or "Unassigned"].append(summary_row)
        year_groups[f"Year {student.year}" if student.year else "Unassigned"].append(summary_row)

    current_role = get_effective_role(current_user)
    scope_label = get_user_scope_label(current_user) if current_role in {"hod", "advisor", "staff", "student"} else "College-wide"
    payload: dict[str, Any] = {
        "role": current_role,
        "scope_label": scope_label,
        "cards": [],
        "trend": build_trend_data(students, summaries, settings, start_date, end_date, calendar_rules),
        "breakdowns": [],
        "recent_attendance": [serialize_attendance_record(record).model_dump(mode="json") for record in recent_attendance],
        "low_attendance": [],
        "student_list": [],
    }

    low_attendance = sorted(
        [
            {
                "user_id": student.id,
                "name": student.name,
                "identifier": student.identifier,
                "department": student.department,
                "year": student.year,
                "semester": student.semester,
                "attendance_rate": summaries[student.id]["attendance_rate"],
            }
            for student in students
            if summaries[student.id]["attendance_rate"] < 75
        ],
        key=lambda item: item["attendance_rate"],
    )[:8]

    if current_role == "student":
        student_summary = summaries.get(
            current_user.id,
            {
                "attendance_rate": 0.0,
                "present_days": 0,
                "absent_days": 0,
                "total_working_days": 0,
                "current_streak": 0,
                "today_status": "absent",
                "daily_rows": [],
            },
        )
        payload["cards"] = [
            {"label": "Attendance Rate", "value": f'{student_summary["attendance_rate"]:.1f}%', "tone": "good"},
            {"label": "Present Days", "value": student_summary["present_days"], "tone": "neutral"},
            {"label": "Absent Days", "value": student_summary["absent_days"], "tone": "danger"},
            {"label": "Current Streak", "value": f'{student_summary["current_streak"]} days', "tone": "neutral"},
        ]
        payload["profile"] = {
            "name": current_user.name,
            "identifier": current_user.identifier,
            "department": current_user.department,
            "year": current_user.year,
            "semester": current_user.semester,
            "parent_phone_number": current_user.parent_phone_number,
            "today_status": student_summary["today_status"],
        }
        payload["daily_attendance"] = student_summary["daily_rows"][:15]
        payload["recent_attendance"] = payload["recent_attendance"][:6]
        return payload

    institution_accounts = sum(1 for user in visible_users if normalize_role(user.role) != "student")
    total_staff = sum(1 for user in visible_users if normalize_role(user.role) == "staff")
    total_hods = sum(1 for user in visible_users if normalize_role(user.role) == "hod")
    total_class_advisors = sum(
        1
        for user in visible_users
        if normalize_role(user.role) != "student" and has_class_advisor_access(user)
    )

    if current_role == "staff":
        payload["cards"] = [
            {"label": "Assigned Students", "value": len(students), "tone": "neutral"},
            {"label": "Present Today", "value": present_today, "tone": "good"},
            {
                "label": "Average Attendance",
                "value": f"{average_attendance:.1f}%",
                "tone": "good" if average_attendance >= 75 else "warning",
            },
            {
                "label": "Advisor Access",
                "value": "Enabled" if has_class_advisor_access(current_user) else "No",
                "tone": "good" if has_class_advisor_access(current_user) else "neutral",
            },
        ]
    elif current_role == "admin":
        payload["cards"] = [
            {"label": "Total Students", "value": len(students), "tone": "neutral"},
            {"label": "Institution Accounts", "value": institution_accounts, "tone": "neutral"},
            {"label": "Total Staffs", "value": total_staff, "tone": "neutral"},
            {"label": "Total Class Advisors", "value": total_class_advisors, "tone": "neutral"},
            {"label": "Total HODs", "value": total_hods, "tone": "neutral"},
        ]
    else:
        payload["cards"] = [
            {"label": "Total Students", "value": len(students), "tone": "neutral"},
            {"label": "Institution Accounts", "value": institution_accounts, "tone": "neutral"},
            {"label": "Present Today", "value": present_today, "tone": "good"},
            {
                "label": "Average Attendance",
                "value": f"{average_attendance:.1f}%",
                "tone": "good" if average_attendance >= 75 else "warning",
            },
        ]
    payload["low_attendance"] = low_attendance
    payload["student_list"] = [
        {
            "id": student.id,
            "name": student.name,
            "identifier": student.identifier,
            "department": student.department,
            "year": student.year,
            "semester": student.semester,
            "attendance_rate": summaries[student.id]["attendance_rate"],
            "present_today": summaries[student.id]["present_today"],
        }
        for student in students[:12]
    ]

    if current_role == "staff":
        payload["breakdowns"] = []
    elif current_role in {"admin", "principal"}:
        payload["breakdowns"] = []
        if current_role == "principal":
            department_count = len([label for label in department_groups if label and label != "Unassigned"])
            payload["cards"][1] = {"label": "Departments", "value": department_count, "tone": "neutral"}
    else:
        payload["breakdowns"] = [
            {
                "title": "Year Comparison",
                "subtitle": "Attendance rate by academic year",
                "items": build_comparison_items(year_groups),
            },
            {
                "title": "Department Snapshot",
                "subtitle": "Current department and staff context",
                "items": [
                    {"label": current_user.department or "Unassigned", "value": average_attendance, "meta": f"{len(students)} students"},
                    {"label": "Staff in Scope", "value": institution_accounts, "meta": "Users with access"},
                ],
            },
        ]

    return payload


def build_principal_dashboard_payload(
    db: Session,
    current_user: models.User,
    days: int = DEFAULT_DASHBOARD_DAYS,
) -> dict:
    settings = ensure_settings(db)
    calendar_rules = get_calendar_rules(db)
    legacy_holiday_dates = get_legacy_holiday_dates(settings)
    today = get_current_date()
    start_date, end_date = resolve_date_range(days=days)
    current_datetime = get_current_datetime()

    visible_users = get_visible_users_query(db, current_user).order_by(models.User.name.asc()).all()
    students = [user for user in visible_users if normalize_role(user.role) == "student"]
    staff_members = [user for user in visible_users if normalize_role(user.role) == "staff"]
    hod_members = [user for user in visible_users if normalize_role(user.role) == "hod"]

    student_ids = [student.id for student in students]
    student_attendance_records: list[models.Attendance] = []
    if student_ids:
        student_attendance_records = (
            db.query(models.Attendance)
            .filter(
                models.Attendance.user_id.in_(student_ids),
                models.Attendance.date >= start_date,
                models.Attendance.date <= end_date,
            )
            .all()
        )

    student_summaries = build_student_summary_map(
        students,
        student_attendance_records,
        settings,
        start_date,
        end_date,
        calendar_rules,
        "students",
    )

    def build_today_rows(users: list[models.User], audience: str) -> list[dict]:
        if not users:
            return []
        user_ids = [user.id for user in users]
        attendance_records = (
            db.query(models.Attendance)
            .filter(
                models.Attendance.user_id.in_(user_ids),
                models.Attendance.date == today,
            )
            .all()
        )
        records_by_user_date = group_attendance_records_by_user_date(attendance_records)
        return build_class_daily_attendance_rows(
            users,
            {},
            records_by_user_date,
            today,
            current_datetime,
            settings,
            audience,
            calendar_rules,
            legacy_holiday_dates,
        )

    staff_today_rows = build_today_rows(staff_members, "staff")
    hod_today_rows = build_today_rows(hod_members, "staff")

    staff_present_today = sum(
        1 for row in staff_today_rows
        if did_attend_day(row["morning_status"], row["afternoon_status"])
    )
    hod_present_today = sum(
        1 for row in hod_today_rows
        if did_attend_day(row["morning_status"], row["afternoon_status"])
    )
    students_present_today = sum(
        1 for summary in student_summaries.values()
        if summary.get("present_today")
    )
    institute_attendance_rate = round(
        sum(summary.get("attendance_rate", 0.0) for summary in student_summaries.values()) / len(student_summaries),
        1,
    ) if student_summaries else 0.0

    staff_rows_by_department = Counter(
        row.get("department") or "Unassigned"
        for row in staff_today_rows
        if did_attend_day(row["morning_status"], row["afternoon_status"])
    )
    hod_lookup_by_department = {
        (hod.department or "Unassigned"): hod
        for hod in sorted(hod_members, key=lambda item: (item.department or "", item.name.lower()))
    }

    department_labels = sorted(
        {
            normalize_department_name(user.department)
            for user in visible_users
            if normalize_department_name(user.department)
        }
    )
    ordered_departments = order_departments_by_catalog(department_labels)
    uncatalogued_departments = [
        department
        for department in department_labels
        if department not in ordered_departments
    ]
    departments = ordered_departments + uncatalogued_departments

    department_snapshot: list[dict] = []
    for department in departments:
        department_students = [student for student in students if student.department == department]
        department_staff = [staff_user for staff_user in staff_members if staff_user.department == department]
        department_student_count = len(department_students)
        department_attendance_rate = round(
            sum(student_summaries.get(student.id, {}).get("attendance_rate", 0.0) for student in department_students) / department_student_count,
            1,
        ) if department_student_count else 0.0
        hod = hod_lookup_by_department.get(department)
        department_snapshot.append(
            {
                "department": department,
                "hod_name": hod.name if hod else "Not Assigned",
                "staff_count": len(department_staff),
                "student_count": department_student_count,
                "staff_present_today": staff_rows_by_department.get(department, 0),
                "student_present_today": sum(
                    1
                    for student in department_students
                    if student_summaries.get(student.id, {}).get("present_today")
                ),
                "attendance_rate": department_attendance_rate,
            }
        )

    department_snapshot.sort(
        key=lambda item: (
            101 if not item["student_count"] else item["attendance_rate"],
            item["department"].lower(),
        )
    )

    below_threshold_departments = [
        item for item in department_snapshot
        if item["student_count"] and item["attendance_rate"] < 75
    ]
    low_attendance_students = sorted(
        [
            {
                "name": student.name,
                "department": student.department or "Unassigned",
                "attendance_rate": student_summaries.get(student.id, {}).get("attendance_rate", 0.0),
            }
            for student in students
            if student_summaries.get(student.id, {}).get("attendance_rate", 0.0) < 75
        ],
        key=lambda item: (item["attendance_rate"], item["name"].lower()),
    )
    missing_hods_today = [
        row for row in hod_today_rows
        if not did_attend_day(row["morning_status"], row["afternoon_status"])
    ]

    staff_working_day = is_working_day(today, "staff", calendar_rules, legacy_holiday_dates)
    student_working_day = is_working_day(today, "students", calendar_rules, legacy_holiday_dates)

    attention_items: list[dict] = []
    if staff_working_day:
        if missing_hods_today:
            preview_names = ", ".join(row["name"] for row in missing_hods_today[:3])
            if len(missing_hods_today) > 3:
                preview_names = f"{preview_names}, and {len(missing_hods_today) - 3} more"
            attention_items.append(
                {
                    "title": "HOD Attendance Gaps",
                    "tone": "warning",
                    "message": f"{len(missing_hods_today)} HOD account(s) still need attention today: {preview_names}.",
                }
            )
        else:
            attention_items.append(
                {
                    "title": "HOD Attendance Gaps",
                    "tone": "success",
                    "message": "All HOD accounts are marked present in at least one session today.",
                }
            )
    else:
        attention_items.append(
            {
                "title": "HOD Attendance Gaps",
                "tone": "info",
                "message": "Today is not an active staff working day, so HOD attendance triggers are effectively closed.",
            }
        )

    if below_threshold_departments:
        preview_departments = ", ".join(item["department"] for item in below_threshold_departments[:3])
        if len(below_threshold_departments) > 3:
            preview_departments = f"{preview_departments}, and {len(below_threshold_departments) - 3} more"
        attention_items.append(
            {
                "title": "Department Health",
                "tone": "warning",
                "message": f"{len(below_threshold_departments)} department(s) are below 75% attendance in the selected window: {preview_departments}.",
            }
        )
    else:
        attention_items.append(
            {
                "title": "Department Health",
                "tone": "success",
                "message": "All active departments are at or above the 75% attendance threshold in the selected window.",
            }
        )

    if low_attendance_students:
        preview_students = ", ".join(item["name"] for item in low_attendance_students[:3])
        if len(low_attendance_students) > 3:
            preview_students = f"{preview_students}, and {len(low_attendance_students) - 3} more"
        attention_items.append(
            {
                "title": "Students Needing Support",
                "tone": "warning",
                "message": f"{len(low_attendance_students)} student(s) are below 75% attendance in the selected window: {preview_students}.",
            }
        )
    else:
        attention_items.append(
            {
                "title": "Students Needing Support",
                "tone": "success",
                "message": "No students are currently below the 75% attendance threshold in the selected window.",
            }
        )

    total_departments = len(departments)
    summary_cards = [
        {
            "label": "Departments",
            "value": total_departments,
            "tone": "neutral",
            "helper": "Departments with active institute records",
        },
        {
            "label": "Total HODs",
            "value": len(hod_members),
            "tone": "neutral",
            "helper": (
                f"{hod_present_today} marked present today"
                if staff_working_day else "No active staff sessions today"
            ),
        },
        {
            "label": "Staff Present Today",
            "value": staff_present_today,
            "tone": "good" if staff_present_today else "warning",
            "helper": (
                f"{staff_present_today} of {len(staff_members)} staff accounts"
                if staff_working_day else "No active staff sessions today"
            ),
        },
        {
            "label": "Students Present Today",
            "value": students_present_today,
            "tone": "good" if students_present_today else "warning",
            "helper": (
                f"{students_present_today} of {len(students)} students"
                if student_working_day else "No active student sessions today"
            ),
        },
    ]

    return {
        "role": "principal",
        "scope_label": "College-wide",
        "days": days,
        "generated_on": today,
        "institute_attendance_rate": institute_attendance_rate,
        "summary_cards": summary_cards,
        "attention_items": attention_items,
        "department_snapshot": department_snapshot,
    }


def build_student_attendance_snapshot(
    db: Session,
    user: models.User,
    days: Optional[int] = DEFAULT_DASHBOARD_DAYS,
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
) -> dict:
    settings = ensure_settings(db)
    calendar_rules = get_calendar_rules(db)
    audience = get_attendance_calendar_audience_for_user(user)
    if from_date is None and to_date is None and days is None:
        end_date = get_current_date()
        earliest_attendance_date = (
            db.query(func.min(models.Attendance.date))
            .filter(models.Attendance.user_id == user.id)
            .scalar()
        )
        start_date = earliest_attendance_date or end_date
    else:
        start_date, end_date = resolve_date_range(days=days, from_date=from_date, to_date=to_date)

    current_datetime = get_current_datetime()
    legacy_holiday_dates = get_legacy_holiday_dates(settings)
    attendance_dates = get_attendance_display_dates(start_date, end_date, audience, calendar_rules, legacy_holiday_dates)
    working_dates = get_working_dates(start_date, end_date, audience, calendar_rules, legacy_holiday_dates)

    attendance_records = (
        db.query(models.Attendance)
        .filter(
            models.Attendance.user_id == user.id,
            models.Attendance.date >= start_date,
            models.Attendance.date <= end_date,
        )
        .all()
    )

    records_by_date: dict[date, list[models.Attendance]] = defaultdict(list)
    for record in attendance_records:
        records_by_date[record.date].append(record)

    metrics = build_student_attendance_metrics(
        records_by_date,
        attendance_dates,
        working_dates,
        start_date,
        end_date,
        current_datetime,
        settings,
        audience,
        calendar_rules,
        legacy_holiday_dates,
    )

    return {
        "user": serialize_session_user(user),
        "from_date": start_date.isoformat(),
        "to_date": end_date.isoformat(),
        **metrics,
    }


def build_personal_attendance_export(
    snapshot: dict,
    identifier: str,
    audience: str = "students",
) -> tuple[bytes, str]:
    second_label = "Evening" if validate_calendar_audience(audience) == "staff" else "Afternoon"
    workbook_rows: list[list[object]] = [["Date", "Morning Status", f"{second_label} Status", "Daily Total"]]
    for row in snapshot["attendance_rows"]:
        workbook_rows.append(
            [
                row["date"],
                row["morning_status"],
                row["afternoon_status"],
                row["daily_total"],
            ]
        )
    workbook_rows.extend(
        [
            [],
            ["Summary", "Value"],
            ["Attendance Percentage", snapshot["attendance_rate"]],
            ["Present Days", snapshot["present_days"]],
            ["Absent Days", snapshot["absent_days"]],
            ["Attended Sessions", snapshot["attended_sessions"]],
            ["Absent Sessions", snapshot["absent_sessions"]],
        ]
    )
    workbook_bytes = build_excel_workbook_bytes("Attendance", workbook_rows)
    filename = f'{identifier}_attendance_{snapshot["from_date"]}_to_{snapshot["to_date"]}.xlsx'
    return workbook_bytes, filename


def build_paginated_response(page: int, page_size: int, total: int, items: list[dict], **extra_fields):
    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        **extra_fields,
    }


def _excel_column_name(index: int) -> str:
    name = ""
    current = index
    while current > 0:
        current, remainder = divmod(current - 1, 26)
        name = chr(65 + remainder) + name
    return name


def _excel_cell(reference: str, value) -> str:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return f'<c r="{reference}"><v>{value}</v></c>'

    text_value = "" if value is None else str(value)
    preserve_space = text_value != text_value.strip()
    space_attr = ' xml:space="preserve"' if preserve_space else ""
    return (
        f'<c r="{reference}" t="inlineStr">'
        f"<is><t{space_attr}>{escape(text_value)}</t></is>"
        f"</c>"
    )


def build_excel_workbook_bytes(sheet_name: str, rows: list[list[object]]) -> bytes:
    workbook_buffer = io.BytesIO()
    created_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    sheet_rows = []
    for row_index, row_values in enumerate(rows, start=1):
        cells = []
        for column_index, value in enumerate(row_values, start=1):
            reference = f"{_excel_column_name(column_index)}{row_index}"
            cells.append(_excel_cell(reference, value))
        sheet_rows.append(f'<row r="{row_index}">{"".join(cells)}</row>')

    worksheet_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f"<sheetData>{''.join(sheet_rows)}</sheetData>"
        "</worksheet>"
    )

    with zipfile.ZipFile(workbook_buffer, "w", compression=zipfile.ZIP_DEFLATED) as workbook:
        workbook.writestr(
            "[Content_Types].xml",
            (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                '<Default Extension="xml" ContentType="application/xml"/>'
                '<Override PartName="/xl/workbook.xml" '
                'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                '<Override PartName="/xl/worksheets/sheet1.xml" '
                'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
                '<Override PartName="/xl/styles.xml" '
                'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
                '<Override PartName="/docProps/core.xml" '
                'ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
                '<Override PartName="/docProps/app.xml" '
                'ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
                "</Types>"
            ),
        )
        workbook.writestr(
            "_rels/.rels",
            (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" '
                'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
                'Target="xl/workbook.xml"/>'
                '<Relationship Id="rId2" '
                'Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" '
                'Target="docProps/core.xml"/>'
                '<Relationship Id="rId3" '
                'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" '
                'Target="docProps/app.xml"/>'
                "</Relationships>"
            ),
        )
        workbook.writestr(
            "docProps/app.xml",
            (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
                'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
                "<Application>MPNMJEC Smart Attendance System</Application>"
                "</Properties>"
            ),
        )
        workbook.writestr(
            "docProps/core.xml",
            (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
                'xmlns:dc="http://purl.org/dc/elements/1.1/" '
                'xmlns:dcterms="http://purl.org/dc/terms/" '
                'xmlns:dcmitype="http://purl.org/dc/dcmitype/" '
                'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
                "<dc:creator>MPNMJEC Smart Attendance System</dc:creator>"
                f"<dcterms:created xsi:type=\"dcterms:W3CDTF\">{created_at}</dcterms:created>"
                f"<dcterms:modified xsi:type=\"dcterms:W3CDTF\">{created_at}</dcterms:modified>"
                "</cp:coreProperties>"
            ),
        )
        workbook.writestr(
            "xl/workbook.xml",
            (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                "<sheets>"
                f'<sheet name="{escape(sheet_name)}" sheetId="1" r:id="rId1"/>'
                "</sheets>"
                "</workbook>"
            ),
        )
        workbook.writestr(
            "xl/_rels/workbook.xml.rels",
            (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" '
                'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
                'Target="worksheets/sheet1.xml"/>'
                '<Relationship Id="rId2" '
                'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
                'Target="styles.xml"/>'
                "</Relationships>"
            ),
        )
        workbook.writestr(
            "xl/styles.xml",
            (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
                '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
                '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
                '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
                '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
                '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
                "</styleSheet>"
            ),
        )
        workbook.writestr("xl/worksheets/sheet1.xml", worksheet_xml)

    return workbook_buffer.getvalue()


def create_session_payload(user: models.User) -> dict:
    access_token_expires = auth.timedelta(minutes=auth.ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = auth.create_access_token(
        data={"sub": user.identifier},
        expires_delta=access_token_expires,
    )
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": serialize_session_user(user),
    }


@app.post("/token", response_model=schemas.Token)
def login_for_access_token(
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db),
):
    user = auth.authenticate_user(db, form_data.username, form_data.password)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect identifier or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if get_effective_role(user) == "student":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Students should sign in with register number access",
        )

    return create_session_payload(user)


@app.post("/students/access", response_model=schemas.Token)
def student_portal_access(
    payload: schemas.StudentAccessIn,
    db: Session = Depends(get_db),
):
    identifier = payload.identifier.strip()
    if not identifier:
        raise HTTPException(status_code=400, detail="Register number is required")

    user = db.query(models.User).filter(models.User.identifier == identifier).first()
    if (
        user is None
        or get_effective_role(user) != "student"
        or user.dob != payload.dob
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect register number or date of birth",
        )

    return create_session_payload(user)


@app.get("/me", response_model=schemas.SessionUser)
def read_current_user(current_user: models.User = Depends(auth.get_current_active_user)):
    return serialize_session_user(current_user)


@app.post("/me/change-password", response_model=schemas.ActionMessageOut)
def change_current_user_password(
    payload: schemas.PasswordChangeIn,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_active_user),
):
    current_role = get_effective_role(current_user)
    if current_role == "student":
        raise HTTPException(status_code=400, detail="Student accounts do not use password sign-in")

    if not current_user.hashed_password:
        raise HTTPException(
            status_code=400,
            detail="This account does not have a password configured yet. Contact an administrator to reset it.",
        )

    if not auth.verify_password(payload.current_password, current_user.hashed_password):
        raise HTTPException(status_code=400, detail="Current password is incorrect")

    current_user.hashed_password = auth.get_password_hash(payload.new_password)
    db.commit()

    return {"message": "Password changed successfully"}


@app.get("/meta/options")
def read_meta_options(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_active_user),
):
    visible_users = get_visible_users_query(db, current_user).all()
    departments = get_department_options_for_user(current_user)
    roles = sorted({normalize_role(user.role) for user in visible_users if user.role})
    return {
        "departments": departments,
        "roles": roles,
        "sessions": sorted(VALID_SESSIONS),
        "statuses": sorted(VALID_STATUSES),
    }


@app.post("/users/", response_model=schemas.UserOut)
def create_user(
    user: schemas.UserCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("admin", "hod", "advisor")),
):
    current_role = get_effective_role(current_user)
    user_role = validate_role(user.role)
    current_user_department = (
        validate_department_name(current_user.department, required=False)
        if current_role in {"hod", "advisor"}
        else None
    )

    if current_role in {"hod", "advisor"} and user_role != "student":
        raise HTTPException(status_code=403, detail="Only admins can create staff accounts")

    department = validate_department_name(user.department or current_user.department, required=False)
    if current_role in {"hod", "advisor"} and current_user_department and department != current_user_department:
        raise HTTPException(status_code=403, detail="You can only create students within your department")

    if user_role in {"hod", "advisor", "staff", "student"} and not department:
        raise HTTPException(status_code=400, detail="Department is required for this role")

    if user_role == "student" and (user.year is None or user.semester is None):
        raise HTTPException(status_code=400, detail="Year and semester are required for students")

    normalized_assignments = []
    seen_assignment_keys: set[tuple[str, int, int, str]] = set()
    for assignment in user.class_assignments or []:
        assignment_department = validate_department_name(assignment.department or department, required=False)
        if not assignment_department or assignment.year is None or assignment.semester is None:
            raise HTTPException(status_code=400, detail="Department, year, and semester are required for staff class assignments")
        if current_role in {"hod", "advisor"} and current_user_department and assignment_department != current_user_department:
            raise HTTPException(status_code=403, detail="You can only create users within your department")

        assignment_type = validate_assignment_type(assignment.assignment_type)
        assignment_key = (
            assignment_department.lower(),
            assignment.year,
            assignment.semester,
            assignment_type,
        )
        if assignment_key in seen_assignment_keys:
            continue
        seen_assignment_keys.add(assignment_key)
        normalized_assignments.append(
            {
                "department": assignment_department,
                "year": assignment.year,
                "semester": assignment.semester,
                "assignment_type": assignment_type,
            }
        )

    if user_role == "staff":
        invalid_staff_assignments = [
            assignment
            for assignment in normalized_assignments
            if assignment["assignment_type"] != "class_advisor"
        ]
        if invalid_staff_assignments:
            raise HTTPException(
                status_code=400,
                detail="Only class advisor assignments are supported for staff accounts",
            )

    if user_role != "staff" and normalized_assignments:
        raise HTTPException(status_code=400, detail="Class assignments are only supported for staff accounts")

    db_user = models.User(
        name=user.name.strip(),
        role=user_role,
        identifier=user.identifier.strip(),
        department=department,
        year=user.year if user_role == "student" else None,
        semester=user.semester if user_role == "student" else None,
        dob=user.dob,
        address=(user.address or "").strip() or None,
        blood_group=(user.blood_group or "").strip() or None,
        phone_number=(user.phone_number or "").strip() or None,
        parent_phone_number=(user.parent_phone_number or "").strip() or None,
        face_samples=[sample.model_dump(mode="json") for sample in (user.face_samples or [])] or None,
        hashed_password=auth.get_password_hash(user.password),
    )

    try:
        db.add(db_user)
        db.flush()

        if user.embeddings:
            for embedding in user.embeddings:
                db.add(models.Embedding(user_id=db_user.id, embedding_vector=embedding))

        if user_role == "staff":
            for assignment in normalized_assignments:
                db.add(
                    models.StaffClassAssignment(
                        staff_user_id=db_user.id,
                        department=assignment["department"],
                        year=assignment["year"],
                        semester=assignment["semester"],
                        section="all",
                        assignment_type=assignment["assignment_type"],
                    )
                )

        db.commit()
        db.refresh(db_user)
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=400, detail="A user with this identifier already exists")

    return {
        **serialize_session_user(db_user),
        "dob": db_user.dob,
        "address": db_user.address,
        "blood_group": db_user.blood_group,
        "phone_number": db_user.phone_number,
        "parent_phone_number": db_user.parent_phone_number,
        "attendance_rate": None,
        "present_today": None,
    }


@app.put("/users/{user_id}/staff-access", response_model=schemas.UserOut)
def update_staff_access(
    user_id: int,
    payload: schemas.StaffAccessUpdateIn,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("admin")),
):
    target_user = (
        get_visible_users_query(db, current_user)
        .filter(models.User.id == user_id)
        .first()
    )
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")

    target_role = normalize_role(target_user.role)
    if target_role not in {"staff", "hod", "principal", "admin"}:
        raise HTTPException(
            status_code=400,
            detail="This edit flow supports only staff, HOD, principal, and admin accounts",
        )

    department_input = payload.department if payload.department is not None else target_user.department
    department = validate_department_name(department_input, required=False)
    if target_role in {"staff", "hod"} and not department:
        raise HTTPException(status_code=400, detail="Department is required for staff and HOD accounts")

    if target_role != "staff" and (
        payload.is_class_advisor or payload.scope_year is not None or payload.scope_semester is not None
    ):
        raise HTTPException(
            status_code=400,
            detail="Class advisor access can only be managed for staff accounts",
        )

    if target_role == "staff" and payload.is_class_advisor and (payload.scope_year is None or payload.scope_semester is None):
        raise HTTPException(
            status_code=400,
            detail="Year and semester are required when class advisor access is enabled",
        )

    target_user.department = department
    target_user.phone_number = (payload.phone_number or "").strip() or None
    target_user.blood_group = (payload.blood_group or "").strip() or None
    target_user.address = (payload.address or "").strip() or None

    existing_assignments = (
        db.query(models.StaffClassAssignment)
        .filter(models.StaffClassAssignment.staff_user_id == target_user.id)
        .all()
    )
    for assignment in existing_assignments:
        db.delete(assignment)

    if target_role == "staff" and payload.is_class_advisor:
        db.add(
            models.StaffClassAssignment(
                staff_user_id=target_user.id,
                department=department,
                year=int(payload.scope_year),
                semester=int(payload.scope_semester),
                section="all",
                assignment_type="class_advisor",
            )
        )

    db.commit()
    db.refresh(target_user)

    return {
        **serialize_session_user(target_user),
        "dob": target_user.dob,
        "address": target_user.address,
        "blood_group": target_user.blood_group,
        "phone_number": target_user.phone_number,
        "parent_phone_number": target_user.parent_phone_number,
        "attendance_rate": None,
        "present_today": None,
    }


@app.post("/users/{user_id}/reset-password", response_model=schemas.ActionMessageOut)
def reset_user_password(
    user_id: int,
    payload: schemas.PasswordResetIn,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("admin")),
):
    target_user = (
        get_visible_users_query(db, current_user)
        .filter(models.User.id == user_id)
        .first()
    )
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")

    target_role = get_effective_role(target_user)
    if target_role == "student":
        raise HTTPException(status_code=400, detail="Student accounts do not use password sign-in")

    target_user.hashed_password = auth.get_password_hash(payload.new_password)
    db.commit()

    return {"message": f"Password reset successfully for {target_user.name}"}


@app.put("/users/{user_id}/student-profile", response_model=schemas.UserOut)
def update_student_profile(
    user_id: int,
    payload: schemas.StudentUpdateIn,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("admin", "hod", "advisor")),
):
    current_role = get_effective_role(current_user)
    current_user_department = (
        validate_department_name(current_user.department, required=False)
        if current_role in {"hod", "advisor"}
        else None
    )
    target_user = (
        get_visible_users_query(db, current_user)
        .filter(models.User.id == user_id)
        .first()
    )
    if not target_user:
        raise HTTPException(status_code=404, detail="Student not found in your visible scope")

    if normalize_role(target_user.role) != "student":
        raise HTTPException(status_code=400, detail="Only student accounts can be updated here")

    department = validate_department_name(payload.department, required=False)
    if not department:
        raise HTTPException(status_code=400, detail="Department is required for students")

    if current_role in {"hod", "advisor"} and current_user_department and department != current_user_department:
        raise HTTPException(status_code=403, detail="You can only update students within your department")

    if payload.year is None or payload.semester is None:
        raise HTTPException(status_code=400, detail="Year and semester are required for students")

    target_user.name = payload.name.strip()
    target_user.identifier = payload.identifier.strip()
    target_user.department = department
    target_user.year = payload.year
    target_user.semester = payload.semester
    target_user.dob = payload.dob
    target_user.address = payload.address.strip()
    target_user.blood_group = payload.blood_group.strip()
    target_user.parent_phone_number = payload.parent_phone_number.strip()
    target_user.phone_number = (payload.phone_number or "").strip() or None

    try:
        db.commit()
        db.refresh(target_user)
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=400, detail="A user with this identifier already exists")

    return {
        **serialize_session_user(target_user),
        "dob": target_user.dob,
        "address": target_user.address,
        "blood_group": target_user.blood_group,
        "phone_number": target_user.phone_number,
        "parent_phone_number": target_user.parent_phone_number,
        "attendance_rate": None,
        "present_today": None,
    }



@app.post("/users/student-bulk-promote")
def student_bulk_promote(
    payload: schemas.StudentBulkPromoteIn,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("admin", "hod", "advisor")),
):
    current_role = get_effective_role(current_user)
    current_user_department = (
        validate_department_name(current_user.department, required=False)
        if current_role in {"hod", "advisor"}
        else None
    )

    department = validate_department_name(payload.department, required=False)
    if not department:
        raise HTTPException(status_code=400, detail="Department is required")

    if current_role in {"hod", "advisor"} and current_user_department and department != current_user_department:
        raise HTTPException(status_code=403, detail="You can only promote students within your department")

    if payload.action not in {"increment_semester", "increment_year", "custom"}:
        raise HTTPException(status_code=400, detail="Invalid promotion action")

    if payload.action == "custom":
        if payload.target_year is None or payload.target_semester is None:
            raise HTTPException(status_code=400, detail="Target year and semester are required for custom promotion")

    students_query = (
        get_visible_users_query(db, current_user)
        .filter(
            func.lower(models.User.role) == "student",
            models.User.department == department,
            models.User.year == payload.current_year,
            models.User.semester == payload.current_semester
        )
    )

    if payload.action == "increment_semester":
        update_data = {
            models.User.semester: models.User.semester + 1
        }
    elif payload.action == "increment_year":
        update_data = {
            models.User.year: models.User.year + 1,
            models.User.semester: models.User.semester + 1
        }
    else:
        update_data = {
            models.User.year: payload.target_year,
            models.User.semester: payload.target_semester
        }

    updated_count = students_query.update(update_data, synchronize_session=False)

    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Database update failed: {exc}")

    return {
        "count": updated_count,
        "message": f"Successfully updated {updated_count} students."
    }


@app.post("/users/face-embedding", response_model=schemas.FaceEmbeddingResponse)
def extract_face_embedding_for_enrollment(
    req: schemas.RecognizeRequest,
    current_user: models.User = Depends(require_roles("admin", "hod", "advisor")),
):
    ai_service = load_ai_service()

    img = ai_service.base64_to_image(req.image_base64)
    if img is None:
        raise HTTPException(status_code=400, detail="Invalid image payload")

    query_emb = ai_service.extract_face_embedding(img)
    if not query_emb:
        raise HTTPException(status_code=400, detail="No face detected in the frame")

    return {
        "embedding": query_emb,
        "message": "Face detected successfully",
    }


@app.get("/users/", response_model=schemas.UserListResponse)
def read_users(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=50),
    search: str = "",
    role: str = "",
    department: str = "",
    year: Optional[int] = Query(None, ge=1, le=4),
    semester: Optional[int] = Query(None, ge=1, le=8),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("admin", "hod", "advisor", "principal")),
):
    query = get_visible_users_query(db, current_user)

    if search.strip():
        search_term = f"%{search.strip()}%"
        query = query.filter(
            or_(
                models.User.name.ilike(search_term),
                models.User.identifier.ilike(search_term),
            )
        )

    if role.strip():
        query = query.filter(func.lower(models.User.role) == validate_role(role))

    if department.strip():
        query = query.filter(models.User.department == department.strip())

    if year is not None:
        query = query.filter(models.User.year == year)

    if semester is not None:
        query = query.filter(models.User.semester == semester)

    total = query.count()
    users = query.order_by(models.User.name.asc()).offset((page - 1) * page_size).limit(page_size).all()

    settings = ensure_settings(db)
    students = [user_row for user_row in users if normalize_role(user_row.role) == "student"]
    student_ids = [student.id for student in students]
    today = get_current_date()
    date_from = today - timedelta(days=DEFAULT_DASHBOARD_DAYS - 1)
    attendance_records = []
    if student_ids:
        attendance_records = (
            db.query(models.Attendance)
            .filter(
                models.Attendance.user_id.in_(student_ids),
                models.Attendance.date >= date_from,
                models.Attendance.date <= today,
            )
            .all()
        )
    summary_map = build_student_summary_map(
        students,
        attendance_records,
        settings,
        date_from,
        today,
        get_calendar_rules(db),
        "students",
    )

    items = []
    for user_row in users:
        user_payload = serialize_session_user(user_row)
        student_summary = summary_map.get(user_row.id, {})
        items.append(
            {
                **user_payload,
                "dob": user_row.dob,
                "address": user_row.address,
                "blood_group": user_row.blood_group,
                "phone_number": user_row.phone_number,
                "parent_phone_number": user_row.parent_phone_number,
                "attendance_rate": student_summary.get("attendance_rate"),
                "present_today": student_summary.get("present_today"),
            }
        )

    return build_paginated_response(page, page_size, total, items)


@app.get("/admin-user-exports/students/export")
def export_admin_student_user_data(
    search: str = "",
    department: str = "",
    year: Optional[int] = Query(None, ge=1, le=4),
    semester: Optional[int] = Query(None, ge=1, le=8),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("admin")),
):
    workbook_bytes, filename = build_admin_role_user_data_export(
        db,
        current_user,
        target_role="student",
        search=search,
        department=department,
        year=year,
        semester=semester,
    )
    return Response(
        content=workbook_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/admin-user-exports/staff/export")
def export_admin_staff_user_data(
    search: str = "",
    department: str = "",
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("admin")),
):
    workbook_bytes, filename = build_admin_role_user_data_export(
        db,
        current_user,
        target_role="staff",
        search=search,
        department=department,
    )
    return Response(
        content=workbook_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/admin-user-exports/hods/export")
def export_admin_hod_user_data(
    search: str = "",
    department: str = "",
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("admin")),
):
    workbook_bytes, filename = build_admin_role_user_data_export(
        db,
        current_user,
        target_role="hod",
        search=search,
        department=department,
    )
    return Response(
        content=workbook_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/admin-user-exports/principals/export")
def export_admin_principal_user_data(
    search: str = "",
    department: str = "",
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("admin")),
):
    workbook_bytes, filename = build_admin_role_user_data_export(
        db,
        current_user,
        target_role="principal",
        search=search,
        department=department,
    )
    return Response(
        content=workbook_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/dashboard/summary", response_model=schemas.DashboardSummary)
def read_dashboard_summary(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_active_user),
):
    today = get_current_date()
    settings = ensure_settings(db)
    visible_users = get_visible_users_query(db, current_user).all()
    students = [user for user in visible_users if normalize_role(user.role) == "student"]
    student_ids = [student.id for student in students]

    attendance_records = []
    if student_ids:
        attendance_records = (
            db.query(models.Attendance)
            .filter(
                models.Attendance.user_id.in_(student_ids),
                models.Attendance.date == today,
            )
            .all()
        )

    summaries = build_student_summary_map(
        students,
        attendance_records,
        settings,
        today,
        today,
        get_calendar_rules(db),
        "students",
    )
    present_today = sum(1 for item in summaries.values() if item.get("present_today"))
    attendance_rate = round(
        sum(item.get("attendance_rate", 0.0) for item in summaries.values()) / len(summaries),
        2,
    ) if summaries else 0.0

    return {
        "total_students": len(students),
        "total_users": len(visible_users),
        "present_today": present_today,
        "attendance_rate": attendance_rate,
    }


@app.get("/dashboard/overview")
def read_dashboard_overview(
    days: int = Query(DEFAULT_DASHBOARD_DAYS, ge=7, le=180),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_active_user),
):
    return build_scope_overview(db, current_user, days)


@app.get("/principal/dashboard", response_model=schemas.PrincipalDashboardOut)
def read_principal_dashboard(
    days: int = Query(DEFAULT_DASHBOARD_DAYS, ge=7, le=180),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("principal")),
):
    return build_principal_dashboard_payload(db, current_user, days)


@app.get("/faculty/dashboard", response_model=schemas.FacultyDashboardOut)
def read_faculty_dashboard(
    selected_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_faculty_dashboard_access),
):
    return build_faculty_dashboard_payload(
        db,
        current_user,
        selected_date=selected_date,
    )


@app.get("/faculty/attendance/export")
def export_faculty_attendance(
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_faculty_dashboard_access),
):
    workbook_bytes, filename = build_faculty_attendance_export(
        db,
        current_user,
        from_date=from_date,
        to_date=to_date,
    )
    return Response(
        content=workbook_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/class-advisor/students/export")
def export_class_advisor_students(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_class_advisor_export_access),
):
    workbook_bytes, filename = build_class_advisor_student_export(db, current_user)
    return Response(
        content=workbook_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/class-advisor/students", response_model=schemas.UserListResponse)
def read_class_advisor_students(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=50),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_class_advisor_export_access),
):
    query = (
        get_visible_users_query(db, current_user)
        .filter(func.lower(models.User.role) == "student")
    )

    total = query.count()
    students = (
        query.order_by(models.User.name.asc(), models.User.identifier.asc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    items = []
    for student in students:
        items.append(
            {
                **serialize_session_user(student),
                "dob": student.dob,
                "address": student.address,
                "blood_group": student.blood_group,
                "phone_number": student.phone_number,
                "parent_phone_number": student.parent_phone_number,
                "attendance_rate": None,
                "present_today": None,
            }
        )

    return build_paginated_response(page, page_size, total, items)


@app.get("/department-attendance/students", response_model=schemas.DailyAttendanceListResponse)
def read_department_student_attendance(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=50),
    year: Optional[int] = Query(None, ge=1, le=4),
    semester: Optional[int] = Query(None, ge=1, le=8),
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("hod")),
):
    settings = ensure_settings(db)
    items = build_department_student_daily_attendance(
        db,
        current_user,
        year=year,
        semester=semester,
        from_date=from_date,
        to_date=to_date,
    )
    total = len(items)
    paginated_items = items[(page - 1) * page_size: page * page_size]
    return build_paginated_response(
        page,
        page_size,
        total,
        paginated_items,
        session_defaults=build_session_defaults(settings, "students"),
    )


@app.get("/department-attendance/students/export")
def export_department_student_attendance(
    year: Optional[int] = Query(None, ge=1, le=4),
    semester: Optional[int] = Query(None, ge=1, le=8),
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("hod")),
):
    workbook_bytes, filename = build_department_student_attendance_export(
        db,
        current_user,
        year=year,
        semester=semester,
        from_date=from_date,
        to_date=to_date,
    )
    return Response(
        content=workbook_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/department-attendance/staff", response_model=schemas.DailyAttendanceListResponse)
def read_department_staff_attendance(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=50),
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("hod")),
):
    settings = ensure_settings(db)
    items = build_department_staff_daily_attendance(
        db,
        current_user,
        from_date=from_date,
        to_date=to_date,
    )
    total = len(items)
    paginated_items = items[(page - 1) * page_size: page * page_size]
    return build_paginated_response(
        page,
        page_size,
        total,
        paginated_items,
        session_defaults=build_session_defaults(settings, "staff"),
    )


@app.get("/department-attendance/staff/export")
def export_department_staff_attendance(
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("hod")),
):
    workbook_bytes, filename = build_department_staff_attendance_export(
        db,
        current_user,
        from_date=from_date,
        to_date=to_date,
    )
    return Response(
        content=workbook_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/principal-attendance/hods", response_model=schemas.DailyAttendanceListResponse)
def read_principal_hod_attendance(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=50),
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("principal")),
):
    settings = ensure_settings(db)
    items = build_principal_role_daily_attendance(
        db,
        current_user,
        target_role="hod",
        audience="staff",
        from_date=from_date,
        to_date=to_date,
    )
    total = len(items)
    paginated_items = items[(page - 1) * page_size: page * page_size]
    return build_paginated_response(
        page,
        page_size,
        total,
        paginated_items,
        session_defaults=build_session_defaults(settings, "staff"),
    )


@app.get("/principal-attendance/staff", response_model=schemas.DailyAttendanceListResponse)
def read_principal_staff_attendance(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=50),
    department: str = "",
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("principal")),
):
    settings = ensure_settings(db)
    items = build_principal_role_daily_attendance(
        db,
        current_user,
        target_role="staff",
        audience="staff",
        department=department,
        from_date=from_date,
        to_date=to_date,
    )
    total = len(items)
    paginated_items = items[(page - 1) * page_size: page * page_size]
    return build_paginated_response(
        page,
        page_size,
        total,
        paginated_items,
        session_defaults=build_session_defaults(settings, "staff"),
    )


@app.get("/principal-attendance/students", response_model=schemas.DailyAttendanceListResponse)
def read_principal_student_attendance(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=50),
    department: str = "",
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("principal")),
):
    settings = ensure_settings(db)
    items = build_principal_role_daily_attendance(
        db,
        current_user,
        target_role="student",
        audience="students",
        department=department,
        from_date=from_date,
        to_date=to_date,
    )
    total = len(items)
    paginated_items = items[(page - 1) * page_size: page * page_size]
    return build_paginated_response(
        page,
        page_size,
        total,
        paginated_items,
        session_defaults=build_session_defaults(settings, "students"),
    )


@app.get("/principal-attendance/students/export")
def export_principal_student_attendance(
    department: str = "",
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("principal")),
):
    workbook_bytes, filename = build_principal_student_attendance_export(
        db,
        current_user,
        department=department,
        from_date=from_date,
        to_date=to_date,
    )
    return Response(
        content=workbook_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/admin-attendance/students", response_model=schemas.DailyAttendanceListResponse)
def read_admin_student_attendance(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=50),
    search: str = "",
    department: str = "",
    year: Optional[int] = Query(None, ge=1, le=4),
    semester: Optional[int] = Query(None, ge=1, le=8),
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("admin")),
):
    settings = ensure_settings(db)
    items = build_institute_role_daily_attendance(
        db,
        current_user,
        target_role="student",
        audience="students",
        search=search,
        department=department,
        year=year,
        semester=semester,
        from_date=from_date,
        to_date=to_date,
    )
    total = len(items)
    paginated_items = items[(page - 1) * page_size: page * page_size]
    return build_paginated_response(
        page,
        page_size,
        total,
        paginated_items,
        session_defaults=build_session_defaults(settings, "students"),
    )


@app.get("/admin-attendance/students/export")
def export_admin_student_attendance(
    search: str = "",
    department: str = "",
    year: Optional[int] = Query(None, ge=1, le=4),
    semester: Optional[int] = Query(None, ge=1, le=8),
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("admin")),
):
    workbook_bytes, filename = build_institute_role_attendance_export(
        db,
        current_user,
        target_role="student",
        audience="students",
        search=search,
        department=department,
        year=year,
        semester=semester,
        from_date=from_date,
        to_date=to_date,
    )
    return Response(
        content=workbook_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/admin-attendance/staff", response_model=schemas.DailyAttendanceListResponse)
def read_admin_staff_attendance(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=50),
    search: str = "",
    department: str = "",
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("admin")),
):
    settings = ensure_settings(db)
    items = build_institute_role_daily_attendance(
        db,
        current_user,
        target_role="staff",
        audience="staff",
        search=search,
        department=department,
        from_date=from_date,
        to_date=to_date,
    )
    total = len(items)
    paginated_items = items[(page - 1) * page_size: page * page_size]
    return build_paginated_response(
        page,
        page_size,
        total,
        paginated_items,
        session_defaults=build_session_defaults(settings, "staff"),
    )


@app.get("/admin-attendance/staff/export")
def export_admin_staff_attendance(
    search: str = "",
    department: str = "",
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("admin")),
):
    workbook_bytes, filename = build_institute_role_attendance_export(
        db,
        current_user,
        target_role="staff",
        audience="staff",
        search=search,
        department=department,
        from_date=from_date,
        to_date=to_date,
    )
    return Response(
        content=workbook_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/admin-attendance/hods", response_model=schemas.DailyAttendanceListResponse)
def read_admin_hod_attendance(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=50),
    search: str = "",
    department: str = "",
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("admin")),
):
    settings = ensure_settings(db)
    items = build_institute_role_daily_attendance(
        db,
        current_user,
        target_role="hod",
        audience="staff",
        search=search,
        department=department,
        from_date=from_date,
        to_date=to_date,
    )
    total = len(items)
    paginated_items = items[(page - 1) * page_size: page * page_size]
    return build_paginated_response(
        page,
        page_size,
        total,
        paginated_items,
        session_defaults=build_session_defaults(settings, "staff"),
    )


@app.get("/admin-attendance/hods/export")
def export_admin_hod_attendance(
    search: str = "",
    department: str = "",
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("admin")),
):
    workbook_bytes, filename = build_institute_role_attendance_export(
        db,
        current_user,
        target_role="hod",
        audience="staff",
        search=search,
        department=department,
        from_date=from_date,
        to_date=to_date,
    )
    return Response(
        content=workbook_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/admin-attendance/principals", response_model=schemas.DailyAttendanceListResponse)
def read_admin_principal_attendance(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=50),
    search: str = "",
    department: str = "",
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("admin")),
):
    settings = ensure_settings(db)
    items = build_institute_role_daily_attendance(
        db,
        current_user,
        target_role="principal",
        audience="staff",
        search=search,
        department=department,
        from_date=from_date,
        to_date=to_date,
    )
    total = len(items)
    paginated_items = items[(page - 1) * page_size: page * page_size]
    return build_paginated_response(
        page,
        page_size,
        total,
        paginated_items,
        session_defaults=build_session_defaults(settings, "staff"),
    )


@app.get("/admin-attendance/principals/export")
def export_admin_principal_attendance(
    search: str = "",
    department: str = "",
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("admin")),
):
    workbook_bytes, filename = build_institute_role_attendance_export(
        db,
        current_user,
        target_role="principal",
        audience="staff",
        search=search,
        department=department,
        from_date=from_date,
        to_date=to_date,
    )
    return Response(
        content=workbook_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/students/me", response_model=schemas.StudentDashboardOut)
def read_student_dashboard(
    days: Optional[int] = Query(None, ge=7, le=180),
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("student")),
):
    return build_student_attendance_snapshot(
        db,
        current_user,
        days=days,
        from_date=from_date,
        to_date=to_date,
    )


@app.get("/me/attendance", response_model=schemas.StudentDashboardOut)
def read_my_attendance(
    days: Optional[int] = Query(None, ge=7, le=180),
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_active_user),
):
    return build_student_attendance_snapshot(
        db,
        current_user,
        days=days,
        from_date=from_date,
        to_date=to_date,
    )


@app.get("/students/me/attendance/export")
def export_student_attendance(
    days: Optional[int] = Query(None, ge=7, le=180),
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("student")),
):
    snapshot = build_student_attendance_snapshot(
        db,
        current_user,
        days=days,
        from_date=from_date,
        to_date=to_date,
    )
    workbook_bytes, filename = build_personal_attendance_export(
        snapshot,
        current_user.identifier,
        audience="students",
    )
    return Response(
        content=workbook_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/me/attendance/export")
def export_my_attendance(
    days: Optional[int] = Query(None, ge=7, le=180),
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_active_user),
):
    snapshot = build_student_attendance_snapshot(
        db,
        current_user,
        days=days,
        from_date=from_date,
        to_date=to_date,
    )
    workbook_bytes, filename = build_personal_attendance_export(
        snapshot,
        current_user.identifier,
        audience=get_attendance_calendar_audience_for_user(current_user),
    )
    return Response(
        content=workbook_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/users/{user_id}/attendance", response_model=schemas.StudentDashboardOut)
def read_user_attendance_snapshot(
    user_id: int,
    days: Optional[int] = Query(DEFAULT_DASHBOARD_DAYS, ge=7, le=180),
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("admin", "hod", "advisor", "principal", "staff")),
):
    user = get_visible_users_query(db, current_user).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found in your scope")
    return build_student_attendance_snapshot(
        db,
        user,
        days=days,
        from_date=from_date,
        to_date=to_date,
    )


@app.get("/attendance/recent", response_model=list[schemas.AttendanceLogOut])
def read_recent_attendance(
    limit: int = Query(8, ge=1, le=50),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_active_user),
):
    records = (
        get_visible_attendance_query(db, current_user)
        .options(joinedload(models.Attendance.user))
        .order_by(models.Attendance.date.desc(), models.Attendance.time.desc())
        .limit(limit)
        .all()
    )
    return [serialize_attendance_log(record) for record in records]


@app.get("/attendance/records", response_model=schemas.AttendanceListResponse)
def read_attendance_records(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=50),
    search: str = "",
    attendance_date: Optional[date] = None,
    from_date: Optional[date] = Query(None),
    to_date: Optional[date] = Query(None),
    status_filter: str = "",
    department: str = "",
    session_name: str = "",
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_active_user),
):
    query = get_visible_attendance_query(db, current_user)

    if search.strip():
        search_term = f"%{search.strip()}%"
        query = query.filter(
            or_(
                models.User.name.ilike(search_term),
                models.User.identifier.ilike(search_term),
            )
        )

    if attendance_date:
        query = query.filter(models.Attendance.date == attendance_date)
    elif from_date or to_date:
        resolved_start_date = from_date or to_date
        resolved_end_date = to_date or from_date
        if resolved_start_date and resolved_end_date and resolved_start_date > resolved_end_date:
            raise HTTPException(status_code=400, detail="From date must be earlier than or equal to To date")
        if resolved_start_date:
            query = query.filter(models.Attendance.date >= resolved_start_date)
        if resolved_end_date:
            query = query.filter(models.Attendance.date <= resolved_end_date)

    if status_filter.strip():
        query = query.filter(func.lower(models.Attendance.status) == validate_status(status_filter))

    if department.strip():
        query = query.filter(models.User.department == department.strip())

    if session_name.strip():
        query = query.filter(func.lower(models.Attendance.session) == validate_session(session_name))

    total = query.count()
    records = (
        query.options(joinedload(models.Attendance.user))
        .order_by(models.Attendance.date.desc(), models.Attendance.time.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    items = [serialize_attendance_record(record).model_dump(mode="json") for record in records]
    return build_paginated_response(page, page_size, total, items)


@app.get("/attendance/window", response_model=schemas.AttendanceWindowStatusOut)
def read_attendance_window_status(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_attendance_operator),
):
    settings = ensure_settings(db)
    calendar_rules = get_calendar_rules(db)
    legacy_holiday_dates = get_legacy_holiday_dates(settings)
    window_status = resolve_operator_attendance_window(
        get_current_datetime(),
        settings,
        get_attendance_operator_audiences(db, current_user),
        calendar_rules,
        legacy_holiday_dates,
    )
    return serialize_attendance_window_status(window_status)


@app.post("/recognize/", response_model=schemas.RecognizeResponse)
def recognize_face(
    req: schemas.RecognizeRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_attendance_operator),
):
    ai_service = load_ai_service()

    img = ai_service.base64_to_image(req.image_base64)
    if img is None:
        raise HTTPException(status_code=400, detail="Invalid image payload")

    query_emb = ai_service.extract_face_embedding(img)
    if not query_emb:
        raise HTTPException(status_code=400, detail="No face detected in the image")

    visible_users = get_attendance_operator_users_query(db, current_user).all()
    user_ids = [user.id for user in visible_users]
    if not user_ids:
        raise HTTPException(status_code=404, detail="No users found in your scope")

    db_embeddings = db.query(models.Embedding).filter(models.Embedding.user_id.in_(user_ids)).all()
    if not db_embeddings:
        raise HTTPException(status_code=404, detail="No enrolled faces found in your scope")

    all_user_embeddings = [(embedding.user_id, embedding.embedding_vector) for embedding in db_embeddings]
    match_id, confidence = ai_service.find_best_match(
        query_emb,
        all_user_embeddings,
        threshold=FACE_RECOGNITION_THRESHOLD,
        min_margin=FACE_RECOGNITION_MIN_MARGIN,
    )

    if match_id is None:
        return {"status": "failed", "message": "Face not recognized", "confidence": confidence}

    matched_user = db.query(models.User).filter(models.User.id == match_id).first()
    if matched_user is None:
        raise HTTPException(status_code=404, detail="Recognized user record was not found")

    return {
        "status": "success",
        "confidence": confidence,
        "user": serialize_session_user(matched_user),
    }


@app.post("/attendance/", response_model=schemas.AttendanceMarkResponse)
def mark_attendance(
    payload: schemas.AttendanceCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_attendance_operator),
):
    now = get_current_datetime()
    settings = ensure_settings(db)
    calendar_rules = get_calendar_rules(db)
    legacy_holiday_dates = get_legacy_holiday_dates(settings)
    user = get_attendance_operator_users_query(db, current_user).filter(models.User.id == payload.user_id).first()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found in your scope")

    attendance_window = resolve_active_attendance_window(
        now,
        settings,
        get_attendance_calendar_audience_for_user(user),
        calendar_rules,
        legacy_holiday_dates,
    )

    if attendance_window["result_code"] != "open":
        return {
            "already_marked": False,
            "result_code": attendance_window["result_code"],
            "message": attendance_window["message"],
            "session_name": attendance_window["session_name"],
            "attendance": None,
            "user": serialize_session_user(user),
        }

    session_name = attendance_window["session_name"]
    session_label = session_name.title()

    existing_attendance = (
        db.query(models.Attendance)
        .filter(
            models.Attendance.user_id == payload.user_id,
            models.Attendance.date == now.date(),
            models.Attendance.session == session_name,
        )
        .first()
    )
    if existing_attendance:
        return {
            "already_marked": True,
            "result_code": "already_marked",
            "message": f"{session_label} attendance already marked",
            "session_name": session_name,
            "attendance": existing_attendance,
            "user": serialize_session_user(user),
        }

    attendance = models.Attendance(
        user_id=payload.user_id,
        date=now.date(),
        time=now.time(),
        session=session_name,
        status="present",
    )
    db.add(attendance)
    db.commit()
    db.refresh(attendance)
    return {
        "already_marked": False,
        "result_code": "marked",
        "message": f"{session_label} attendance marked",
        "session_name": session_name,
        "attendance": attendance,
        "user": serialize_session_user(user),
    }


@app.post("/attendance/manual", response_model=schemas.AttendanceOut)
def manual_attendance_override(
    payload: schemas.AttendanceOverrideIn,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_manual_override_access),
):
    target_query = get_visible_users_query(db, current_user)
    if payload.user_id is not None:
        target_user = target_query.filter(models.User.id == payload.user_id).first()
    elif payload.identifier is not None and payload.identifier.strip():
        target_user = target_query.filter(models.User.identifier == payload.identifier.strip()).first()
    else:
        raise HTTPException(status_code=400, detail="User identifier is required for manual override")

    if not target_user:
        raise HTTPException(status_code=404, detail="User not found in your scope")

    current_role = get_effective_role(current_user)
    if current_role == "principal" and normalize_role(target_user.role) != "hod":
        raise HTTPException(
            status_code=403,
            detail="Principal manual overrides are limited to HOD attendance records",
        )

    settings = ensure_settings(db)
    calendar_rules = get_calendar_rules(db)
    legacy_holiday_dates = get_legacy_holiday_dates(settings)
    audience = get_attendance_calendar_audience_for_user(target_user)
    if not is_working_day(payload.date, audience, calendar_rules, legacy_holiday_dates):
        day_type, matched_rule = resolve_calendar_day_type(payload.date, audience, calendar_rules, legacy_holiday_dates)
        if day_type == "holiday":
            detail = "Attendance can only be corrected on working days. This date is marked as a holiday."
        elif day_type == "attendance_not_conducted":
            detail = "Attendance can only be corrected on working days. Mark this date as a working day first."
        else:
            detail = "Attendance can only be corrected on working days."
        if matched_rule and (matched_rule.reason or "").strip():
            detail = f"{detail} Reason: {matched_rule.reason.strip()}"
        raise HTTPException(status_code=400, detail=detail)

    session_value = validate_session(payload.session)
    status_value = validate_status(payload.status)
    time_value = payload.time if status_value in PRESENT_STATUSES else None
    existing_attendance = (
        db.query(models.Attendance)
        .filter(
            models.Attendance.user_id == target_user.id,
            models.Attendance.date == payload.date,
            models.Attendance.session == session_value,
        )
        .first()
    )

    if existing_attendance:
        existing_attendance.status = status_value
        existing_attendance.time = time_value
        db.commit()
        db.refresh(existing_attendance)
        return existing_attendance

    attendance = models.Attendance(
        user_id=target_user.id,
        date=payload.date,
        time=time_value,
        session=session_value,
        status=status_value,
    )
    db.add(attendance)
    db.commit()
    db.refresh(attendance)
    return attendance


@app.get("/settings", response_model=schemas.SettingsOut)
def read_settings(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("admin")),
):
    settings = ensure_settings(db)
    return serialize_settings(settings, get_calendar_rules(db))


@app.put("/settings", response_model=schemas.SettingsOut)
def update_settings(
    payload: schemas.SettingsBase,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("admin")),
):
    settings = ensure_settings(db)
    normalized_rules: list[dict] = []
    seen_rule_keys: set[tuple[date, date, str, str, str]] = set()

    for rule in payload.calendar_rules:
        normalized_audience = validate_calendar_audience(rule.audience)
        normalized_day_type = validate_calendar_day_type(rule.day_type)
        normalized_reason = (rule.reason or "").strip()
        rule_key = (
            rule.start_date,
            rule.end_date,
            normalized_audience,
            normalized_day_type,
            normalized_reason,
        )
        if rule_key in seen_rule_keys:
            continue
        seen_rule_keys.add(rule_key)
        normalized_rules.append(
            {
                "start_date": rule.start_date,
                "end_date": rule.end_date,
                "audience": normalized_audience,
                "day_type": normalized_day_type,
                "reason": normalized_reason or None,
            }
        )

    if not normalized_rules and payload.holidays:
        for holiday in payload.holidays:
            rule_key = (holiday, holiday, "both", "holiday", "")
            if rule_key in seen_rule_keys:
                continue
            seen_rule_keys.add(rule_key)
            normalized_rules.append(
                {
                    "start_date": holiday,
                    "end_date": holiday,
                    "audience": "both",
                    "day_type": "holiday",
                    "reason": None,
                }
            )

    settings.holidays = []
    settings.morning_time_start = payload.student_attendance.morning_time_start
    settings.morning_time_end = payload.student_attendance.morning_time_end
    settings.afternoon_time_start = payload.student_attendance.afternoon_time_start
    settings.afternoon_time_end = payload.student_attendance.afternoon_time_end
    settings.staff_morning_time_start = payload.staff_attendance.morning_time_start
    settings.staff_morning_time_end = payload.staff_attendance.morning_time_end
    settings.staff_evening_time_start = payload.staff_attendance.evening_time_start
    settings.staff_evening_time_end = payload.staff_attendance.evening_time_end

    db.query(models.CalendarRule).delete(synchronize_session=False)
    for rule in normalized_rules:
        db.add(models.CalendarRule(**rule))

    db.commit()
    db.refresh(settings)
    return serialize_settings(settings, get_calendar_rules(db))
