from __future__ import annotations

import os
import base64
import binascii
import threading
from collections import defaultdict
from typing import Any

try:
    import cv2
    import numpy as np
    from insightface.app import FaceAnalysis
except ImportError as exc:
    cv2 = None
    np = None
    FaceAnalysis = None
    FACE_RECOGNITION_IMPORT_ERROR = exc
else:
    FACE_RECOGNITION_IMPORT_ERROR = None

INSIGHTFACE_MODEL_NAME = os.getenv("INSIGHTFACE_MODEL_NAME", "buffalo_l")
INSIGHTFACE_DET_SIZE = int(os.getenv("INSIGHTFACE_DET_SIZE", "320"))
INSIGHTFACE_MODEL_ROOT = os.getenv("INSIGHTFACE_MODEL_ROOT", "~/.insightface")


def init_face_analyzer():
    """
    Initialize the InsightFace analyzer once so kiosk scans do not pay the
    full model startup cost on the first recognition request.
    """
    if FaceAnalysis is None:
        raise RuntimeError("Face recognition dependencies are not installed") from FACE_RECOGNITION_IMPORT_ERROR

    # The app is explicitly configured with the CPU provider.  ``ctx_id=0``
    # still makes some InsightFace models try to select CUDA during prepare,
    # which leaves face detection unavailable on CPU-only kiosk machines.
    app = FaceAnalysis(
        name=INSIGHTFACE_MODEL_NAME,
        root=INSIGHTFACE_MODEL_ROOT,
        providers=['CPUExecutionProvider'],
    )
    app.prepare(ctx_id=-1, det_size=(INSIGHTFACE_DET_SIZE, INSIGHTFACE_DET_SIZE))
    return app


def warmup_face_analyzer(app):
    """
    Run one blank inference to pre-load runtime kernels and reduce first-scan
    latency in kiosk mode.
    """
    if app is None or np is None:
        return

    try:
        blank_frame = np.zeros((INSIGHTFACE_DET_SIZE, INSIGHTFACE_DET_SIZE, 3), dtype=np.uint8)
        app.get(blank_frame)
    except Exception:
        # Warmup is best-effort only; real requests should still proceed.
        pass

# Singleton for the analyzer.  Do not make a failed cold-start permanent: a
# transient model download failure on a hosted runtime must be retried by the
# next request or health check instead of leaving recognition disabled forever.
face_analyzer = None
face_analyzer_error: Exception | None = None
face_analyzer_lock = threading.Lock()


def get_face_analyzer():
    global face_analyzer, face_analyzer_error

    if FaceAnalysis is None:
        raise RuntimeError("Face recognition dependencies are not installed") from FACE_RECOGNITION_IMPORT_ERROR

    if face_analyzer is not None:
        return face_analyzer

    with face_analyzer_lock:
        if face_analyzer is not None:
            return face_analyzer

        try:
            analyzer = init_face_analyzer()
            warmup_face_analyzer(analyzer)
        except Exception as exc:
            face_analyzer_error = exc
            raise RuntimeError(
                "Face recognition could not initialize. Check the model cache and the ONNX runtime configuration."
            ) from exc

        face_analyzer = analyzer
        face_analyzer_error = None
        return face_analyzer


def ensure_face_recognition_available():
    if FACE_RECOGNITION_IMPORT_ERROR is not None:
        raise RuntimeError(
            "Face recognition dependencies are not installed. "
            "Run .\\start-backend.ps1 to install the biometric vision runtime, "
            "then restart the backend."
        ) from FACE_RECOGNITION_IMPORT_ERROR

    get_face_analyzer()

def base64_to_image(base64_str: str) -> Any:
    """Convert base64 string to OpenCV image format."""
    if cv2 is None or np is None:
        return None

    if not isinstance(base64_str, str) or not base64_str.strip():
        return None

    try:
        # Keep only the data portion of a data URL.  Splitting once also
        # avoids corrupting a valid payload that happens to contain this text.
        encoded_image = base64_str.split("base64,", 1)[-1]
        img_data = base64.b64decode(encoded_image, validate=True)
        nparr = np.frombuffer(img_data, np.uint8)
        return cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    except (ValueError, binascii.Error):
        return None

def extract_face_embedding(img: Any):
    """
    Given an image, extract the primary face embedding.
    Returns the embedding vector as a list of floats (size 512).
    """
    if img is None:
        return None

    analyzer = face_analyzer or get_face_analyzer()
    faces = analyzer.get(img)
    if not faces:
        return None

    # Do not rely on provider-specific output ordering.  In a kiosk frame the
    # largest detected face is the person standing at the scanner.
    def face_area(face: Any) -> float:
        bbox = getattr(face, "bbox", None)
        if bbox is None or len(bbox) < 4:
            return 0.0
        return max(0.0, float(bbox[2] - bbox[0])) * max(0.0, float(bbox[3] - bbox[1]))

    primary_face = max(faces, key=face_area)
    
    # embedding is a numpy array of 512 dimensions for ArcFace
    embedding = primary_face.normed_embedding
    return embedding.tolist()

def compare_embeddings(emb1: list, emb2: list) -> float:
    """
    Compute Cosine Similarity between two embeddings.
    InsightFace embeddings are normalized, so dot product is cosine similarity.
    """
    vec1 = np.array(emb1)
    vec2 = np.array(emb2)
    similarity = np.dot(vec1, vec2)
    return float(similarity)

def rank_user_matches(query_embedding: list, all_user_embeddings: list):
    """
    Collapse multiple stored embeddings per user into a single best score.
    This helps recognition stay stable when some samples differ slightly,
    such as with glasses or small pose changes.
    """
    grouped_scores = defaultdict(list)

    for user_id, db_emb in all_user_embeddings:
        grouped_scores[user_id].append(compare_embeddings(query_embedding, db_emb))

    ranked = sorted(
        (
            (
                user_id,
                max(scores),
                float(sum(scores) / len(scores)),
            )
            for user_id, scores in grouped_scores.items()
        ),
        key=lambda item: (item[1], item[2]),
        reverse=True,
    )
    return ranked


def find_best_match(
    query_embedding: list,
    all_user_embeddings: list,
    threshold: float = 0.4,
    min_margin: float = 0.03,
):
    """
    Given a list of tuples (user_id, database_embedding), find the best match.
    Uses the best score per user plus a small margin check so we can be a bit
    more tolerant without accepting ambiguous matches.
    """
    ranked_matches = rank_user_matches(query_embedding, all_user_embeddings)
    if not ranked_matches:
        return None, -1.0

    best_match_id, highest_similarity, _ = ranked_matches[0]
    second_best_similarity = ranked_matches[1][1] if len(ranked_matches) > 1 else -1.0

    if highest_similarity < threshold:
        return None, highest_similarity

    if second_best_similarity >= 0 and (highest_similarity - second_best_similarity) < min_margin:
        return None, highest_similarity

    return best_match_id, highest_similarity
