import pytest
from conftest import create_user


def test_attendance_window_mode_filtering(client, db_session):
    admin = create_user(db_session, identifier="admin@test.com", role="admin", name="Admin User")
    token = client.post("/token", data={"username": "admin@test.com", "password": "Password123"}).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    # Query attendance window with student mode
    res_student = client.get("/attendance/window?mode=student", headers=headers)
    assert res_student.status_code == 200
    assert "is_open" in res_student.json()

    # Query attendance window with staff mode
    res_staff = client.get("/attendance/window?mode=staff", headers=headers)
    assert res_staff.status_code == 200
    assert "is_open" in res_staff.json()


def test_recognize_mode_user_scope_filtering(client, db_session):
    admin = create_user(db_session, identifier="admin@test.com", role="admin", name="Admin User")
    token = client.post("/token", data={"username": "admin@test.com", "password": "Password123"}).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    # When invalid image payload is sent, recognize returns 400
    res_student_recognize = client.post("/recognize/", json={"image_base64": "invalid_base64", "mode": "student"}, headers=headers)
    assert res_student_recognize.status_code == 400
    assert res_student_recognize.json()["detail"] == "Invalid image payload"

    res_staff_recognize = client.post("/recognize/", json={"image_base64": "invalid_base64", "mode": "staff"}, headers=headers)
    assert res_staff_recognize.status_code == 400
    assert res_staff_recognize.json()["detail"] == "Invalid image payload"
