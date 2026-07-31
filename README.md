---
title: MPNMJEC Smart Attendance API
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
---

# MPNMJEC Smart Attendance System

MPNMJEC Smart Attendance System is a full-stack attendance platform for academic institutions. It provides role-based dashboards for administrators, HODs, advisors, staff, principals, and students, plus a separate kiosk experience for biometric attendance capture.

## Deployment Links

- Admin and student app: https://your-vercel-app.vercel.app
- Kiosk app: https://your-kiosk-vercel-app.vercel.app
- Backend API: https://your-hf-username-your-space-name.hf.space
- Backend health check: https://your-hf-username-your-space-name.hf.space/

## Screenshots

### Main Login

![Main app login](docs/screenshots/admin-login.png)

### Kiosk Login

![Kiosk login](docs/screenshots/kiosk-login.png)

## Features

- Role-based access for admin, HOD, advisor, principal, staff, and student users.
- Student portal login with register number and date of birth.
- Staff/admin password login with JWT authentication.
- Attendance dashboards with department, year, semester, date, and role filters.
- Manual attendance override for authorized users.
- Staff, student, HOD, principal, and department attendance reporting.
- CSV/XLSX-style data export endpoints for attendance and user data.
- Class advisor student export flow.
- Attendance calendar and session window settings.
- Biometric kiosk recognition flow using InsightFace when the vision stack is enabled.
- Separate kiosk-only frontend deployment.

## Tech Stack

- Frontend: React 19, Vite, React Router, Axios, Lucide React, Framer Motion.
- Backend: FastAPI, Uvicorn, SQLAlchemy, Alembic, Pydantic.
- Database: Supabase Postgres.
- Authentication: JWT with `python-jose`, password hashing with Passlib/Bcrypt.
- Face recognition: InsightFace, ONNX Runtime, OpenCV, NumPy.
- Deployment: Vercel for frontend apps, Hugging Face Docker Space for backend.

## Architecture Overview

```text
FastAPI backend on Hugging Face Docker Space
https://your-hf-username-your-space-name.hf.space
  |
  | SQLAlchemy / psycopg2
  v
Supabase Postgres
```

## Project Structure

```text
backend/                 FastAPI app, models, auth, DB config, AI service
frontend/                React/Vite app and kiosk build
migrations/              Alembic migrations
tests/                   Backend tests
docs/screenshots/        README screenshots
Dockerfile               Hugging Face Docker Space backend image
supabase_schema.sql      Fresh Supabase schema setup
start-backend.ps1        Local backend launcher
start-frontend.ps1       Local frontend launcher
start-kiosk.ps1          Local kiosk launcher
```

## Local Setup

### 1. Clone And Install Tools

Install:

- Python 3.11 or newer
- Node.js 20 or newer
- Git

Then clone the repository and open PowerShell in the project root.

### 2. Backend Environment

Create `backend/.env` from `backend/.env.example`.

Important backend variables:

```env
SUPABASE_DATABASE_URL=postgresql://postgres.PROJECT_REF:YOUR_PASSWORD@aws-REGION.pooler.supabase.com:5432/postgres
DATABASE_SSLMODE=require
DATABASE_CONNECT_TIMEOUT=5
SECRET_KEY=replace_with_a_long_random_secret_value
ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=30
APP_TIMEZONE=Asia/Kolkata
PRELOAD_FACE_RECOGNITION=true
FRONTEND_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174
ADMIN_EMAIL=admin@example.local
ADMIN_PASSWORD=replace_with_strong_admin_password
```

Use the Supabase pooler connection string for hosted deployments. If the database password contains special characters like `@`, `#`, `%`, `/`, `?`, or `^`, percent-encode it before putting it in the URL.

### 3. Frontend Environment

Create `frontend/.env`:

```env
VITE_API_URL=http://127.0.0.1:8000
```

For production Vercel deployments:

```env
VITE_API_URL=https://your-hf-username-your-space-name.hf.space
```

### 4. Prepare Supabase

For a fresh Supabase project, open the Supabase SQL Editor and run:

```text
supabase_schema.sql
```

### 5. Start Backend

```powershell
.\start-backend.ps1
```

The backend starts at:

```text
http://127.0.0.1:8000
```

Face enrollment and kiosk recognition are installed and started by default:

```powershell
 .\start-backend.ps1
```

Use `-CoreOnly` only when intentionally running the non-biometric API.
On Windows, the launcher installs the face runtime without requiring Microsoft
C++ Build Tools.

### 6. Seed Admin / Update Credentials

When `SUPABASE_DATABASE_URL` is left empty in `backend/.env`, the backend automatically connects to the local SQLite database at `backend/attendance.db`.

To seed or update admin credentials from `backend/.env` into the database:

```powershell
.\backend\.venv\Scripts\python.exe -m backend.seed_admin
```

To view or inspect the SQLite database, open `backend/attendance.db` in **DB Browser for SQLite**.

### 7. Start Frontend

In a second PowerShell terminal:

```powershell
.\start-frontend.ps1
```

Open:

```text
http://127.0.0.1:5173
```

### 8. Start Kiosk Locally

In another terminal:

```powershell
.\start-kiosk.ps1
```

Open:

```text
http://127.0.0.1:5174
```

## Testing

Backend tests:

```powershell
.\backend\.venv\Scripts\pytest.exe
```

Frontend lint:

```powershell
cd frontend
npm run lint
```

Frontend production build:

```powershell
cd frontend
npm run build
```

Kiosk production build:

```powershell
cd frontend
npm run build:kiosk
```

## Deployment

### Backend: Hugging Face Docker Space

This repository is configured as a Docker Space through the YAML block at the top of this README:

```yaml
sdk: docker
app_port: 7860
```

Add these Hugging Face Space secrets or variables in Space Settings:

```env
SUPABASE_DATABASE_URL=your_supabase_pooler_connection_string
DATABASE_SSLMODE=require
DATABASE_CONNECT_TIMEOUT=5
SECRET_KEY=your_long_random_secret
ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=30
APP_TIMEZONE=Asia/Kolkata
FACE_RECOGNITION_THRESHOLD=0.40
FACE_RECOGNITION_MIN_MARGIN=0.03
INSIGHTFACE_MODEL_NAME=buffalo_l
INSIGHTFACE_DET_SIZE=320
PRELOAD_FACE_RECOGNITION=true
FRONTEND_ORIGINS=https://your-vercel-app.vercel.app,https://your-kiosk-vercel-app.vercel.app
ADMIN_EMAIL=your_admin_email
ADMIN_PASSWORD=your_admin_password
```

Push changes to the Hugging Face Space repository to rebuild the backend.

### Frontend: Vercel Main App

Vercel project settings:

```text
Root directory: frontend
Framework preset: Vite
Build command: npm run build
Output directory: dist
```

Environment variable:

```env
VITE_API_URL=https://your-hf-username-your-space-name.hf.space
```

### Frontend: Vercel Kiosk App

Vercel project settings:

```text
Root directory: frontend
Framework preset: Vite
Build command: npm run build:kiosk
Output directory: dist-kiosk
```

Environment variable:

```env
VITE_API_URL=https://your-hf-username-your-space-name.hf.space
```

## Security Notes

- Do not commit `backend/.env` or `frontend/.env`.
- Keep `SECRET_KEY`, `SUPABASE_DATABASE_URL`, and `ADMIN_PASSWORD` private.
- Do not put backend secrets in `frontend/.env`; Vite variables are exposed to the browser.
- Rotate test admin passwords before production use.

## Useful API Endpoints

- `GET /` health check
- `POST /token` staff/admin login
- `POST /students/access` student login
- `GET /me` current user session
- `GET /dashboard/overview` dashboard summary
- `GET /attendance/window` current attendance window
- `POST /recognize/` face recognition
- `POST /attendance/` mark attendance
