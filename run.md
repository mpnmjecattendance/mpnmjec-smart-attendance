# How to Run the Project

## Backend

1. Activate the virtual environment:
   ```powershell
   & ".\backend\venv\Scripts\Activate.ps1"
   ```

2. Go to the backend folder and start the server:
   ```powershell
   cd backend
   python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
   ```

   > Runs at: http://127.0.0.1:8000  
   > API Docs: http://127.0.0.1:8000/docs

---

## Frontend

```powershell
cd frontend
npm install      # only needed first time
npm run dev
```

> Runs at: http://127.0.0.1:5173

---

## Easy Way (use the scripts)

```powershell
.\start-backend.ps1    # starts backend
.\start-frontend.ps1   # starts frontend
```
