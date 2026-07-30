import sys
from pathlib import Path

from sqlalchemy import Column, Integer, String, ForeignKey, Time, Date, JSON, UniqueConstraint
from sqlalchemy.orm import relationship

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.database import Base

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, index=True)
    role = Column(String)  # Admin, HOD, Advisor, Principal, Student
    identifier = Column(String, unique=True, index=True)  # email for staff, reg_no for student
    hashed_password = Column(String, nullable=True)  # For staff
    department = Column(String, nullable=True)
    year = Column(Integer, nullable=True)
    semester = Column(Integer, nullable=True)
    dob = Column(Date, nullable=True)
    address = Column(String, nullable=True)
    blood_group = Column(String, nullable=True)
    phone_number = Column(String, nullable=True)
    parent_phone_number = Column(String, nullable=True)
    face_samples = Column(JSON, nullable=True)
    
    embeddings = relationship(
        "Embedding",
        back_populates="user",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    attendances = relationship(
        "Attendance",
        back_populates="user",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    class_assignments = relationship(
        "StaffClassAssignment",
        back_populates="staff",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

class Embedding(Base):
    __tablename__ = "embeddings"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    embedding_vector = Column(JSON)  # Store vector as JSON list
    
    user = relationship("User", back_populates="embeddings")

class Attendance(Base):
    __tablename__ = "attendance"
    __table_args__ = (
        UniqueConstraint("user_id", "date", "session", name="uq_attendance_user_date_session"),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    date = Column(Date, index=True)
    time = Column(Time)
    session = Column(String)  # morning, afternoon
    status = Column(String)  # present, absent, late
    
    user = relationship("User", back_populates="attendances")


class StaffClassAssignment(Base):
    __tablename__ = "staff_class_assignments"
    id = Column(Integer, primary_key=True, index=True)
    staff_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    department = Column(String, nullable=False)
    year = Column(Integer, nullable=False)
    semester = Column(Integer, nullable=False)
    section = Column(String, nullable=False, default="all")
    assignment_type = Column(String, nullable=False)

    staff = relationship("User", back_populates="class_assignments")

class Setting(Base):
    __tablename__ = "settings"
    id = Column(Integer, primary_key=True, index=True)
    holidays = Column(JSON)  # List of holiday dates
    morning_time_start = Column(Time)
    morning_time_end = Column(Time)
    afternoon_time_start = Column(Time)
    afternoon_time_end = Column(Time)
    staff_morning_time_start = Column(Time, nullable=True)
    staff_morning_time_end = Column(Time, nullable=True)
    staff_evening_time_start = Column(Time, nullable=True)
    staff_evening_time_end = Column(Time, nullable=True)


class CalendarRule(Base):
    __tablename__ = "calendar_rules"
    id = Column(Integer, primary_key=True, index=True)
    start_date = Column(Date, nullable=False, index=True)
    end_date = Column(Date, nullable=False, index=True)
    audience = Column(String, nullable=False)
    day_type = Column(String, nullable=False)
    reason = Column(String, nullable=True)
