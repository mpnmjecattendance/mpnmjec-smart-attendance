from datetime import date


def test_staff_login_accepts_valid_password(client, user_factory):
    user_factory(
        identifier="admin@example.test",
        password="Admin123!",
        role="admin",
        name="Admin",
    )

    response = client.post(
        "/token",
        data={"username": "admin@example.test", "password": "Admin123!"},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["token_type"] == "bearer"
    assert payload["user"]["role"] == "admin"


def test_staff_login_rejects_wrong_password(client, user_factory):
    user_factory(
        identifier="admin@example.test",
        password="Admin123!",
        role="admin",
    )

    response = client.post(
        "/token",
        data={"username": "admin@example.test", "password": "Wrong123!"},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )

    assert response.status_code == 401


def test_student_login_requires_matching_dob(client, user_factory):
    user_factory(
        identifier="REG001",
        password="unused-password",
        role="student",
        name="Student One",
        department="Computer Science and Engineering",
        year=1,
        semester=1,
        dob=date(2004, 5, 12),
    )

    response = client.post(
        "/students/access",
        json={"identifier": "REG001", "dob": "2004-05-12"},
    )

    assert response.status_code == 200
    assert response.json()["user"]["role"] == "student"


def test_student_login_rejects_wrong_dob(client, user_factory):
    user_factory(
        identifier="REG001",
        password="unused-password",
        role="student",
        name="Student One",
        department="Computer Science and Engineering",
        year=1,
        semester=1,
        dob=date(2004, 5, 12),
    )

    response = client.post(
        "/students/access",
        json={"identifier": "REG001", "dob": "2004-05-13"},
    )

    assert response.status_code == 401


def test_student_cannot_access_user_management(client, user_factory):
    user_factory(
        identifier="REG001",
        password="unused-password",
        role="student",
        name="Student One",
        department="Computer Science and Engineering",
        year=1,
        semester=1,
        dob=date(2004, 5, 12),
    )
    login_response = client.post(
        "/students/access",
        json={"identifier": "REG001", "dob": "2004-05-12"},
    )
    token = login_response.json()["access_token"]

    response = client.get(
        "/users/",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 403
