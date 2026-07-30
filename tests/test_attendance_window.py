from datetime import datetime, time as dt_time

from backend import main


def login_token(client, identifier, password):
    response = client.post(
        "/token",
        data={"username": identifier, "password": password},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert response.status_code == 200
    return response.json()["access_token"]


def configure_split_attendance_windows(db_session):
    settings = main.ensure_settings(db_session)
    settings.morning_time_start = dt_time(10, 0)
    settings.morning_time_end = dt_time(11, 0)
    settings.afternoon_time_start = dt_time(14, 0)
    settings.afternoon_time_end = dt_time(15, 0)
    settings.staff_morning_time_start = dt_time(8, 0)
    settings.staff_morning_time_end = dt_time(9, 0)
    settings.staff_evening_time_start = dt_time(16, 0)
    settings.staff_evening_time_end = dt_time(17, 0)
    db_session.commit()


def test_kiosk_window_opens_when_any_visible_audience_is_open(client, db_session, user_factory, monkeypatch):
    user_factory(
        identifier="admin@example.test",
        password="Admin123!",
        role="admin",
        name="Admin",
    )
    user_factory(
        identifier="staff@example.test",
        password="Staff123!",
        role="staff",
        name="Staff Member",
        department="Computer Science and Engineering",
    )
    user_factory(
        identifier="REG001",
        password="Student123!",
        role="student",
        name="Student One",
        department="Computer Science and Engineering",
        year=1,
        semester=1,
    )
    configure_split_attendance_windows(db_session)
    monkeypatch.setattr(main, "get_current_datetime", lambda: datetime(2026, 5, 8, 8, 30))

    token = login_token(client, "admin@example.test", "Admin123!")
    response = client.get("/attendance/window", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["is_open"] is True
    assert payload["result_code"] == "open"


def test_kiosk_mark_uses_recognized_users_attendance_window(client, db_session, user_factory, monkeypatch):
    user_factory(
        identifier="admin@example.test",
        password="Admin123!",
        role="admin",
        name="Admin",
    )
    staff_user = user_factory(
        identifier="staff@example.test",
        password="Staff123!",
        role="staff",
        name="Staff Member",
        department="Computer Science and Engineering",
    )
    student_user = user_factory(
        identifier="REG001",
        password="Student123!",
        role="student",
        name="Student One",
        department="Computer Science and Engineering",
        year=1,
        semester=1,
    )
    configure_split_attendance_windows(db_session)
    monkeypatch.setattr(main, "get_current_datetime", lambda: datetime(2026, 5, 8, 8, 30))

    token = login_token(client, "admin@example.test", "Admin123!")
    headers = {"Authorization": f"Bearer {token}"}

    staff_response = client.post("/attendance/", json={"user_id": staff_user.id}, headers=headers)
    assert staff_response.status_code == 200
    staff_payload = staff_response.json()
    assert staff_payload["result_code"] == "marked"
    assert staff_payload["session_name"] == "morning"

    student_response = client.post("/attendance/", json={"user_id": student_user.id}, headers=headers)
    assert student_response.status_code == 200
    student_payload = student_response.json()
    assert student_payload["result_code"] == "before_window"
    assert student_payload["attendance"] is None
