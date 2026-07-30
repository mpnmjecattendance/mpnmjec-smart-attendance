import os
from pathlib import Path

_test_data_dir = Path(__file__).resolve().parent / ".tmp"
_test_data_dir.mkdir(exist_ok=True)
_test_db_path = _test_data_dir / "attendance_test.db"
if _test_db_path.exists():
    _test_db_path.unlink()

os.environ["SUPABASE_DATABASE_URL"] = f"sqlite:///{_test_db_path.as_posix()}"
os.environ["DATABASE_SSLMODE"] = ""
os.environ["SECRET_KEY"] = "test-secret-key"
os.environ["ADMIN_EMAIL"] = "admin@example.test"
os.environ["ADMIN_PASSWORD"] = "Admin123!"
os.environ["PRELOAD_FACE_RECOGNITION"] = "0"

import pytest
from fastapi.testclient import TestClient

from backend import auth, database, models
from backend.main import app


@pytest.fixture(autouse=True)
def reset_database():
    models.Base.metadata.drop_all(bind=database.engine)
    models.Base.metadata.create_all(bind=database.engine)
    yield
    models.Base.metadata.drop_all(bind=database.engine)


@pytest.fixture()
def db_session():
    db = database.SessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture()
def client():
    return TestClient(app)


def create_user(db, *, identifier, password="Password123", role="admin", name="Test User", **fields):
    user = models.User(
        identifier=identifier,
        hashed_password=auth.get_password_hash(password),
        role=role,
        name=name,
        **fields,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@pytest.fixture()
def user_factory(db_session):
    def factory(**kwargs):
        return create_user(db_session, **kwargs)

    return factory
