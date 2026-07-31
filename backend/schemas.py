from datetime import date as dt_date, time as dt_time
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


VALID_CALENDAR_AUDIENCES = {"students", "staff", "both"}
VALID_CALENDAR_DAY_TYPES = {"holiday", "working", "attendance_not_conducted"}


class StaffClassAssignmentOut(BaseModel):
    department: str
    year: int
    semester: int
    assignment_type: str

    model_config = ConfigDict(from_attributes=True)


class StaffClassAssignmentIn(BaseModel):
    department: str
    year: int
    semester: int
    assignment_type: str


class SessionUser(BaseModel):
    id: int
    name: str
    role: str
    identifier: str
    department: Optional[str] = None
    year: Optional[int] = None
    semester: Optional[int] = None
    phone_number: Optional[str] = None
    parent_phone_number: Optional[str] = None
    is_class_advisor: bool = False
    can_take_attendance: bool = False
    scope_label: Optional[str] = None
    class_assignments: List[StaffClassAssignmentOut] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class Token(BaseModel):
    access_token: str
    token_type: str
    user: SessionUser


class TokenData(BaseModel):
    username: Optional[str] = None


class StudentAccessIn(BaseModel):
    identifier: str
    dob: dt_date


class ActionMessageOut(BaseModel):
    message: str


class UserBase(BaseModel):
    name: str
    role: str
    identifier: str
    department: Optional[str] = None
    year: Optional[int] = None
    semester: Optional[int] = None
    dob: Optional[dt_date] = None
    address: Optional[str] = None
    blood_group: Optional[str] = None
    phone_number: Optional[str] = None
    parent_phone_number: Optional[str] = None


class FaceSampleIn(BaseModel):
    angle: str
    image_base64: str


class UserCreate(UserBase):
    password: str = Field(..., min_length=6)
    embeddings: Optional[List[List[float]]] = None
    face_samples: Optional[List[FaceSampleIn]] = None
    class_assignments: List[StaffClassAssignmentIn] = Field(default_factory=list)


class PasswordChangeIn(BaseModel):
    current_password: str = Field(..., min_length=1)
    new_password: str = Field(..., min_length=6)

    @model_validator(mode="after")
    def validate_password_change(self):
        if self.current_password == self.new_password:
            raise ValueError("New password must be different from the current password")
        return self


class PasswordResetIn(BaseModel):
    new_password: str = Field(..., min_length=6)


class StaffAccessUpdateIn(BaseModel):
    department: Optional[str] = None
    phone_number: Optional[str] = None
    blood_group: Optional[str] = None
    address: Optional[str] = None
    is_class_advisor: bool = False
    scope_year: Optional[int] = None
    scope_semester: Optional[int] = None


class StudentUpdateIn(BaseModel):
    name: str
    identifier: str
    department: str
    year: int
    semester: int
    dob: dt_date
    address: str
    blood_group: str
    parent_phone_number: str
    phone_number: Optional[str] = None


class StudentBulkPromoteIn(BaseModel):
    department: str
    current_year: int
    current_semester: int
    action: str
    target_year: Optional[int] = None
    target_semester: Optional[int] = None



class UserOut(UserBase):
    id: int
    attendance_rate: Optional[float] = None
    present_today: Optional[bool] = None
    is_class_advisor: bool = False
    can_take_attendance: bool = False
    scope_label: Optional[str] = None
    class_assignments: List[StaffClassAssignmentOut] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class UserListResponse(BaseModel):
    items: List[UserOut]
    total: int
    page: int
    page_size: int


class AttendanceBase(BaseModel):
    date: dt_date
    time: Optional[dt_time] = None
    session: str
    status: str


class AttendanceCreate(BaseModel):
    user_id: int


class AttendanceOut(AttendanceBase):
    id: int
    user_id: int

    model_config = ConfigDict(from_attributes=True)


class AttendanceMarkResponse(BaseModel):
    already_marked: bool
    result_code: str
    message: str
    session_name: Optional[str] = None
    attendance: Optional[AttendanceOut] = None
    user: SessionUser


class AttendanceWindowStatusOut(BaseModel):
    is_open: bool
    result_code: str
    message: str
    session_name: Optional[str] = None


class AudienceSessionDefaultsOut(BaseModel):
    morning: dt_time
    afternoon: dt_time


class AttendanceRecordOut(BaseModel):
    id: int
    user_id: int
    user_name: str
    identifier: str
    role: str
    department: Optional[str] = None
    year: Optional[int] = None
    semester: Optional[int] = None
    date: dt_date
    time: Optional[dt_time] = None
    session: str
    status: str


class AttendanceListResponse(BaseModel):
    items: List[AttendanceRecordOut]
    total: int
    page: int
    page_size: int


class DailyAttendanceRowOut(BaseModel):
    user_id: int
    name: str
    identifier: str
    role: str
    department: Optional[str] = None
    year: Optional[int] = None
    semester: Optional[int] = None
    date: dt_date
    morning_status: str
    afternoon_status: str
    daily_total: float
    attendance_rate: Optional[float] = None
    is_working_day: bool = True


class DailyAttendanceListResponse(BaseModel):
    items: List[DailyAttendanceRowOut]
    total: int
    page: int
    page_size: int
    session_defaults: Optional[AudienceSessionDefaultsOut] = None


class AttendanceLogOut(BaseModel):
    id: int
    user_id: int
    user_name: str
    identifier: str
    department: Optional[str] = None
    date: dt_date
    time: Optional[dt_time] = None
    session: str
    status: str


class AttendanceOverrideIn(BaseModel):
    user_id: Optional[int] = None
    identifier: Optional[str] = None
    date: dt_date
    session: str
    status: str
    time: Optional[dt_time] = None


class DashboardSummary(BaseModel):
    total_students: int
    total_users: int
    present_today: int
    attendance_rate: float


class StudentAttendanceDayOut(BaseModel):
    date: dt_date
    morning_status: str
    afternoon_status: str
    overall_status: str
    daily_total: float


class StudentDashboardOut(BaseModel):
    user: SessionUser
    from_date: dt_date
    to_date: dt_date
    attendance_rate: float
    present_days: float
    absent_days: float
    total_working_days: int
    attended_sessions: int
    absent_sessions: int
    total_sessions: int
    current_streak: int
    present_today: bool
    today_status: str
    today_morning_status: str
    today_afternoon_status: str
    today_daily_total: float
    attendance_rows: List[StudentAttendanceDayOut] = Field(default_factory=list)
    daily_rows: List[StudentAttendanceDayOut] = Field(default_factory=list)


class FacultyStudentOut(BaseModel):
    user_id: int
    name: str
    identifier: str
    department: Optional[str] = None
    year: Optional[int] = None
    semester: Optional[int] = None
    attendance_rate: float


class FacultyDailyAttendanceRowOut(BaseModel):
    user_id: int
    name: str
    identifier: str
    year: Optional[int] = None
    semester: Optional[int] = None
    morning_status: str
    afternoon_status: str
    daily_total: float
    attendance_rate: float


class FacultySessionSummaryOut(BaseModel):
    present: int
    absent: int
    pending: int
    no_session: int


class FacultyTodayStatusOut(BaseModel):
    morning: FacultySessionSummaryOut
    afternoon: FacultySessionSummaryOut


class FacultySessionDefaultsOut(BaseModel):
    morning: dt_time
    afternoon: dt_time


class FacultyDashboardOut(BaseModel):
    scope_label: str
    scope_warning: Optional[str] = None
    history_start: dt_date
    selected_date: dt_date
    selected_date_is_working_day: bool
    today_is_working_day: bool
    total_students: int
    today_present_count: int
    today_absent_count: int
    attendance_rate: float
    today_status: FacultyTodayStatusOut
    low_attendance: List[FacultyStudentOut] = Field(default_factory=list)
    students: List[FacultyStudentOut] = Field(default_factory=list)
    daily_attendance: List[FacultyDailyAttendanceRowOut] = Field(default_factory=list)
    session_defaults: FacultySessionDefaultsOut


class DashboardCardOut(BaseModel):
    label: str
    value: str | int | float
    tone: str = "neutral"
    helper: Optional[str] = None


class PrincipalDashboardAttentionOut(BaseModel):
    title: str
    tone: str = "info"
    message: str


class PrincipalDepartmentSnapshotOut(BaseModel):
    department: str
    hod_name: str
    staff_count: int
    student_count: int
    staff_present_today: int
    student_present_today: int
    attendance_rate: float


class PrincipalDashboardOut(BaseModel):
    role: str
    scope_label: str
    days: int
    generated_on: dt_date
    institute_attendance_rate: float
    summary_cards: List[DashboardCardOut] = Field(default_factory=list)
    attention_items: List[PrincipalDashboardAttentionOut] = Field(default_factory=list)
    department_snapshot: List[PrincipalDepartmentSnapshotOut] = Field(default_factory=list)


class CalendarRuleBase(BaseModel):
    start_date: dt_date
    end_date: dt_date
    audience: str
    day_type: str
    reason: Optional[str] = None

    @model_validator(mode="after")
    def validate_calendar_rule(self):
        if self.start_date > self.end_date:
            raise ValueError("Start date must be earlier than or equal to end date")
        if self.audience not in VALID_CALENDAR_AUDIENCES:
            raise ValueError("Audience must be students, staff, or both")
        if self.day_type not in VALID_CALENDAR_DAY_TYPES:
            raise ValueError("Day type must be holiday, working, or attendance_not_conducted")
        return self


class CalendarRuleIn(CalendarRuleBase):
    pass


class CalendarRuleOut(CalendarRuleBase):
    id: int

    model_config = ConfigDict(from_attributes=True)


class StudentAttendanceTimingSettings(BaseModel):
    morning_time_start: dt_time
    morning_time_end: dt_time
    afternoon_time_start: dt_time
    afternoon_time_end: dt_time

    @model_validator(mode="after")
    def validate_student_attendance_windows(self):
        if self.morning_time_start >= self.morning_time_end:
            raise ValueError("Morning start must be earlier than morning end")
        if self.afternoon_time_start >= self.afternoon_time_end:
            raise ValueError("Afternoon start must be earlier than afternoon end")
        if self.morning_time_end >= self.afternoon_time_start:
            raise ValueError("Morning end must be earlier than afternoon start")
        return self


class StaffAttendanceTimingSettings(BaseModel):
    morning_time_start: dt_time
    morning_time_end: dt_time
    evening_time_start: dt_time
    evening_time_end: dt_time

    @model_validator(mode="after")
    def validate_staff_attendance_windows(self):
        if self.morning_time_start >= self.morning_time_end:
            raise ValueError("Staff morning start must be earlier than morning end")
        if self.evening_time_start >= self.evening_time_end:
            raise ValueError("Staff evening start must be earlier than evening end")
        if self.morning_time_end >= self.evening_time_start:
            raise ValueError("Staff morning end must be earlier than evening start")
        return self


class SettingsBase(BaseModel):
    holidays: List[dt_date] = Field(default_factory=list)
    calendar_rules: List[CalendarRuleIn] = Field(default_factory=list)
    student_attendance: StudentAttendanceTimingSettings
    staff_attendance: StaffAttendanceTimingSettings


class SettingsOut(SettingsBase):
    id: int
    calendar_rules: List[CalendarRuleOut] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class RecognizeRequest(BaseModel):
    image_base64: str
    mode: Optional[str] = "student"


class RecognizeResponse(BaseModel):
    status: str
    confidence: float
    message: Optional[str] = None
    user: Optional[SessionUser] = None


class FaceEmbeddingResponse(BaseModel):
    embedding: List[float]
    message: str
