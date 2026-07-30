import os
import sys
from getpass import getpass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().with_name(".env"))

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import auth, database, models

# Ensure tables are built!
models.Base.metadata.create_all(bind=database.engine)

def read_admin_credentials():
    admin_email = os.getenv("ADMIN_EMAIL", "").strip()
    if not admin_email or admin_email == "admin@example.local":
        admin_email = "admin@mpnmjec.ac.in"

    admin_password = os.getenv("ADMIN_PASSWORD", "").strip()
    if not admin_password:
        admin_password = getpass("Enter new admin password: ").strip()

    if not admin_email:
        raise ValueError("Admin email is required")

    if not admin_password:
        raise ValueError("Admin password is required")

    return admin_email, admin_password

db = database.SessionLocal()

admin_email, admin_password = read_admin_credentials()

existing = db.query(models.User).filter(models.User.identifier == admin_email).first()

if not existing:
    admin_user = models.User(
        name="System Admin",
        role="admin",
        identifier=admin_email,
        hashed_password=auth.get_password_hash(admin_password)
    )
    db.add(admin_user)
    db.commit()
    print(f"Admin user ({admin_email}) created successfully.")
else:
    existing.role = "admin"
    if not existing.name:
        existing.name = "System Admin"
    existing.hashed_password = auth.get_password_hash(admin_password)
    db.commit()
    print(f"Admin user ({admin_email}) password updated successfully.")

db.close()
