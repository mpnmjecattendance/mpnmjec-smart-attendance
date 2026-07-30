import uvicorn
import os

# Hugging Face sets the PORT env variable automatically (usually 7860)
port = int(os.environ.get("PORT", 7860))

if __name__ == "__main__":
    print(f"Starting FastAPI server on port {port}...")
    uvicorn.run("backend.main:app", host="0.0.0.0", port=port)
