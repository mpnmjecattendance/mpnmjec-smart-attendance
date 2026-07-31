import { useCallback, useEffect, useRef, useState } from 'react';
import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';

import { attendanceApi, getApiErrorMessage } from '../api';

// These assets have a versioned URL so browsers cannot reuse the former Git
// LFS pointer that was cached under the old, unversioned path.
const MEDIAPIPE_ASSET_ROOT = `${import.meta.env.BASE_URL}mediapipe-0.10.34-r2`;
const FACE_DETECTOR_MODEL_PATH = `${import.meta.env.BASE_URL}models/blaze_face_short_range-0.10.34-r2.tflite`;
const READY_MESSAGE = 'Ready for next person';
const DETECTION_INTERVAL_MS = 120;
const RECOGNITION_COOLDOWN_MS = 1200;
const MIN_STABLE_DETECTIONS = 2;
const MAX_MISSED_DETECTIONS = 4;
const MIN_FACE_INSIDE_SCAN_RATIO = 0.40;

const STAGE_MAP = {
  booting: {
    message: 'Starting scanner...',
    tone: 'info',
  },
  ready: {
    message: READY_MESSAGE,
    tone: 'neutral',
  },
  scanning: {
    message: 'Scanning...',
    tone: 'info',
  },
  success: {
    message: 'Attendance marked',
    tone: 'success',
  },
  duplicate: {
    message: 'Already marked today',
    tone: 'warning',
  },
  before_window: {
    message: 'Attendance has not started yet',
    tone: 'info',
  },
  between_sessions: {
    message: 'Morning closed. Afternoon starts soon',
    tone: 'warning',
  },
  day_closed: {
    message: "Today's attendance window is closed",
    tone: 'warning',
  },
  no_session: {
    message: 'No attendance scheduled today',
    tone: 'warning',
  },
  attendance_not_conducted: {
    message: 'Attendance not conducted today',
    tone: 'warning',
  },
  failed: {
    message: 'Face not recognized',
    tone: 'danger',
  },
  error: {
    message: 'Scanner unavailable',
    tone: 'danger',
  },
};

const ATTENDANCE_STAGE_BY_RESULT = {
  marked: 'success',
  already_marked: 'duplicate',
  before_window: 'before_window',
  between_sessions: 'between_sessions',
  day_closed: 'day_closed',
  no_session: 'no_session',
  attendance_not_conducted: 'attendance_not_conducted',
};

function resolveAttendanceStage(resultCode) {
  return ATTENDANCE_STAGE_BY_RESULT[resultCode] || 'failed';
}

function getDetectionArea(detection) {
  const box = detection?.boundingBox;
  return (box?.width || 0) * (box?.height || 0);
}

function getPrimaryDetection(detections = []) {
  if (!detections.length) {
    return null;
  }

  return [...detections].sort((left, right) => getDetectionArea(right) - getDetectionArea(left))[0];
}

function mapBoundingBoxToViewport(boundingBox, videoElement) {
  if (!boundingBox || !videoElement?.videoWidth || !videoElement?.videoHeight) {
    return null;
  }

  const viewport = videoElement.getBoundingClientRect();
  const videoWidth = videoElement.videoWidth;
  const videoHeight = videoElement.videoHeight;

  const scale = Math.max(viewport.width / videoWidth, viewport.height / videoHeight);
  const renderedWidth = videoWidth * scale;
  const renderedHeight = videoHeight * scale;
  const offsetX = (viewport.width - renderedWidth) / 2;
  const offsetY = (viewport.height - renderedHeight) / 2;

  const left = offsetX + (boundingBox.originX * scale);
  const top = offsetY + (boundingBox.originY * scale);
  const width = boundingBox.width * scale;
  const height = boundingBox.height * scale;

  const clampedLeft = Math.max(0, Math.min(viewport.width, left));
  const clampedTop = Math.max(0, Math.min(viewport.height, top));
  const clampedWidth = Math.max(0, Math.min(width, viewport.width - clampedLeft));
  const clampedHeight = Math.max(0, Math.min(height, viewport.height - clampedTop));

  return {
    left: clampedLeft,
    top: clampedTop,
    width: clampedWidth,
    height: clampedHeight,
  };
}

function getScanFrameViewportBox(videoElement, scanFrameElement) {
  if (!videoElement || !scanFrameElement) {
    return null;
  }

  const videoViewport = videoElement.getBoundingClientRect();
  const scanViewport = scanFrameElement.getBoundingClientRect();

  const left = Math.max(0, Math.min(videoViewport.width, scanViewport.left - videoViewport.left));
  const top = Math.max(0, Math.min(videoViewport.height, scanViewport.top - videoViewport.top));
  const right = Math.max(0, Math.min(videoViewport.width, scanViewport.right - videoViewport.left));
  const bottom = Math.max(0, Math.min(videoViewport.height, scanViewport.bottom - videoViewport.top));
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);

  if (width < 80 || height < 80) {
    return null;
  }

  return { left, top, width, height };
}

function getIntersectionArea(firstBox, secondBox) {
  const left = Math.max(firstBox.left, secondBox.left);
  const top = Math.max(firstBox.top, secondBox.top);
  const right = Math.min(firstBox.left + firstBox.width, secondBox.left + secondBox.width);
  const bottom = Math.min(firstBox.top + firstBox.height, secondBox.top + secondBox.height);

  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function isFaceInsideScanFrame(faceBox, scanBox) {
  if (!faceBox || !scanBox || faceBox.width <= 0 || faceBox.height <= 0) {
    return false;
  }

  const centerX = faceBox.left + faceBox.width / 2;
  const centerY = faceBox.top + faceBox.height / 2;
  const centerInside =
    centerX >= scanBox.left
    && centerX <= scanBox.left + scanBox.width
    && centerY >= scanBox.top
    && centerY <= scanBox.top + scanBox.height;

  if (!centerInside) {
    return false;
  }

  const faceArea = faceBox.width * faceBox.height;
  const visibleFaceRatio = getIntersectionArea(faceBox, scanBox) / faceArea;
  return visibleFaceRatio >= MIN_FACE_INSIDE_SCAN_RATIO;
}

function mapViewportBoxToVideoCrop(viewportBox, videoElement) {
  if (!viewportBox || !videoElement?.videoWidth || !videoElement?.videoHeight) {
    return null;
  }

  const viewport = videoElement.getBoundingClientRect();
  const videoWidth = videoElement.videoWidth;
  const videoHeight = videoElement.videoHeight;
  const scale = Math.max(viewport.width / videoWidth, viewport.height / videoHeight);
  const renderedWidth = videoWidth * scale;
  const renderedHeight = videoHeight * scale;
  const offsetX = (viewport.width - renderedWidth) / 2;
  const offsetY = (viewport.height - renderedHeight) / 2;

  const sourceLeft = Math.max(0, Math.min(videoWidth, (viewportBox.left - offsetX) / scale));
  const sourceTop = Math.max(0, Math.min(videoHeight, (viewportBox.top - offsetY) / scale));
  const sourceRight = Math.max(0, Math.min(videoWidth, (viewportBox.left + viewportBox.width - offsetX) / scale));
  const sourceBottom = Math.max(0, Math.min(videoHeight, (viewportBox.top + viewportBox.height - offsetY) / scale));
  const sourceWidth = Math.max(0, sourceRight - sourceLeft);
  const sourceHeight = Math.max(0, sourceBottom - sourceTop);

  if (sourceWidth < 80 || sourceHeight < 80) {
    return null;
  }

  return {
    sourceLeft: Math.round(sourceLeft),
    sourceTop: Math.round(sourceTop),
    sourceWidth: Math.round(sourceWidth),
    sourceHeight: Math.round(sourceHeight),
  };
}

export function KioskPage({ token, mode = 'student', onUnauthorized }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const scanFrameRef = useRef(null);
  const streamRef = useRef(null);
  const detectorRef = useRef(null);
  const processingRef = useRef(false);
  const resetTimerRef = useRef(null);
  const audioContextRef = useRef(null);
  const stableDetectionsRef = useRef(0);
  const missedDetectionsRef = useRef(0);
  const lastRecognitionAtRef = useRef(0);

  const [stage, setStage] = useState('booting');
  const [cameraReady, setCameraReady] = useState(false);
  const [detectorReady, setDetectorReady] = useState(false);
  const [statusText, setStatusText] = useState(STAGE_MAP.booting.message);
  const [faceBox, setFaceBox] = useState(null);

  const stageConfig = STAGE_MAP[stage] || STAGE_MAP.ready;

  const stopCamera = useCallback(() => {
    if (resetTimerRef.current) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    stableDetectionsRef.current = 0;
    missedDetectionsRef.current = 0;
    setFaceBox(null);
    setCameraReady(false);
  }, []);

  const bindVideoStream = useCallback(async () => {
    if (!videoRef.current || !streamRef.current) {
      return;
    }

    if (videoRef.current.srcObject !== streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }

    try {
      await videoRef.current.play();
    } catch {
      // Allow the next render pass to retry if autoplay races with camera startup.
    }
  }, []);

  const setVideoRef = useCallback((node) => {
    videoRef.current = node;
    if (node && streamRef.current) {
      if (node.srcObject !== streamRef.current) {
        node.srcObject = streamRef.current;
      }
      node.play().catch(() => { });
    }
  }, []);

  const resetForNextPerson = useCallback(() => {
    stableDetectionsRef.current = 0;
    missedDetectionsRef.current = 0;
    setFaceBox(null);
    setStage('ready');
    setStatusText(READY_MESSAGE);
  }, []);

  const queueReset = useCallback((delay = 2400) => {
    if (resetTimerRef.current) {
      window.clearTimeout(resetTimerRef.current);
    }

    resetTimerRef.current = window.setTimeout(() => {
      resetForNextPerson();
      resetTimerRef.current = null;
    }, delay);
  }, [resetForNextPerson]);

  const startCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStage('error');
      setStatusText('Camera is not supported on this device');
      return;
    }

    try {
      setStage('booting');
      setStatusText(detectorReady ? 'Starting camera...' : 'Loading face detector...');
      stopCamera();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      });

      stream.getVideoTracks().forEach((track) => {
        track.enabled = true;
      });

      streamRef.current = stream;
      setCameraReady(true);
      bindVideoStream();

      if (detectorReady) {
        setStage('ready');
        setStatusText(READY_MESSAGE);
      }
    } catch {
      setStage('error');
      setStatusText('Camera permission blocked');
    }
  }, [bindVideoStream, detectorReady, stopCamera]);

  useEffect(() => {
    let cancelled = false;

    async function initializeFaceDetector() {
      try {
        let vision;
        try {
          vision = await FilesetResolver.forVisionTasks(
            'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm'
          );
        } catch {
          vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_ASSET_ROOT);
        }

        let detector;
        try {
          detector = await FaceDetector.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
            },
            runningMode: 'VIDEO',
            minDetectionConfidence: 0.35,
            minSuppressionThreshold: 0.3,
          });
        } catch {
          detector = await FaceDetector.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: FACE_DETECTOR_MODEL_PATH,
            },
            runningMode: 'VIDEO',
            minDetectionConfidence: 0.35,
            minSuppressionThreshold: 0.3,
          });
        }

        if (cancelled) {
          detector.close();
          return;
        }

        detectorRef.current = detector;
        setDetectorReady(true);
      } catch {
        if (!cancelled) {
          setStage('error');
          setStatusText('Face detector unavailable');
        }
      }
    }

    initializeFaceDetector();

    return () => {
      cancelled = true;
      detectorRef.current?.close?.();
      detectorRef.current = null;
    };
  }, []);

  useEffect(() => {
    document.body.classList.add('kiosk-active');
    startCamera();

    return () => {
      document.body.classList.remove('kiosk-active');
      stopCamera();
      if (audioContextRef.current && typeof audioContextRef.current.close === 'function') {
        audioContextRef.current.close().catch(() => { });
        audioContextRef.current = null;
      }
    };
  }, [startCamera, stopCamera]);

  useEffect(() => {
    if (cameraReady) {
      bindVideoStream();
    }
  }, [bindVideoStream, cameraReady]);

  useEffect(() => {
    if (cameraReady && detectorReady && stage === 'booting') {
      setStage('ready');
      setStatusText(READY_MESSAGE);
    }
  }, [cameraReady, detectorReady, stage]);

  const captureFrame = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) {
      return null;
    }

    const video = videoRef.current;
    if (video.readyState < 2) {
      return null;
    }

    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    const scanBox = getScanFrameViewportBox(video, scanFrameRef.current);
    const crop = mapViewportBoxToVideoCrop(scanBox, video);

    if (crop) {
      canvas.width = crop.sourceWidth;
      canvas.height = crop.sourceHeight;
      context.drawImage(
        video,
        crop.sourceLeft,
        crop.sourceTop,
        crop.sourceWidth,
        crop.sourceHeight,
        0,
        0,
        crop.sourceWidth,
        crop.sourceHeight,
      );
    } else {
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
    }

    return canvas.toDataURL('image/jpeg', 0.88);
  }, []);

  const playFeedbackTone = useCallback(async (toneType) => {
    if (typeof window === 'undefined') {
      return;
    }

    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) {
      return;
    }

    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContextConstructor();
      }

      const context = audioContextRef.current;
      if (context.state === 'suspended') {
        await context.resume();
      }

      const patterns = {
        success: [
          { frequency: 880, duration: 0.08, delay: 0 },
          { frequency: 1174, duration: 0.1, delay: 0.1 },
        ],
        warning: [
          { frequency: 620, duration: 0.08, delay: 0 },
          { frequency: 620, duration: 0.08, delay: 0.14 },
        ],
        error: [
          { frequency: 320, duration: 0.12, delay: 0 },
          { frequency: 240, duration: 0.14, delay: 0.16 },
        ],
      };
      const sequence = patterns[toneType] || patterns.error;

      sequence.forEach((note) => {
        const oscillator = context.createOscillator();
        const gainNode = context.createGain();
        const startAt = context.currentTime + note.delay;
        const stopAt = startAt + note.duration;

        oscillator.type = toneType === 'success' ? 'sine' : 'triangle';
        oscillator.frequency.setValueAtTime(note.frequency, startAt);

        gainNode.gain.setValueAtTime(0.0001, startAt);
        gainNode.gain.exponentialRampToValueAtTime(0.06, startAt + 0.01);
        gainNode.gain.exponentialRampToValueAtTime(0.0001, stopAt);

        oscillator.connect(gainNode);
        gainNode.connect(context.destination);
        oscillator.start(startAt);
        oscillator.stop(stopAt);
      });
    } catch {
      // Ignore audio feedback failures so kiosk flow remains uninterrupted.
    }
  }, []);

  const runRecognitionCycle = useCallback(async () => {
    if (!cameraReady || !detectorReady || processingRef.current || resetTimerRef.current || stage === 'error') {
      return;
    }

    processingRef.current = true;
    setStage('scanning');
    setStatusText('Checking attendance window...');

    try {
      const windowStatus = await attendanceApi.windowStatus(token, mode);
      if (!windowStatus.is_open) {
        const blockedStage = resolveAttendanceStage(windowStatus.result_code);
        setStage(blockedStage);
        setStatusText(windowStatus.message || STAGE_MAP[blockedStage]?.message || READY_MESSAGE);
        playFeedbackTone('warning');
        queueReset(2300);
        return;
      }

      const imageBase64 = captureFrame();
      if (!imageBase64) {
        setStage('ready');
        setStatusText(READY_MESSAGE);
        return;
      }

      setStatusText(STAGE_MAP.scanning.message);
      const recognized = await attendanceApi.recognize(token, imageBase64, mode);

      if (recognized.status !== 'success' || !recognized.user) {
        setStage('failed');
        setStatusText(STAGE_MAP.failed.message);
        playFeedbackTone('error');
        queueReset();
        return;
      }

      const attendance = await attendanceApi.mark(token, recognized.user.id, mode);
      const resultCode = attendance.result_code || (attendance.already_marked ? 'already_marked' : 'marked');
      const nextStage = resolveAttendanceStage(resultCode);
      const nextMessage = attendance.message
        ? `${recognized.user.name} - ${attendance.message}`
        : STAGE_MAP[nextStage]?.message || READY_MESSAGE;

      setStage(nextStage);
      setStatusText(nextMessage);
      playFeedbackTone(resultCode === 'marked' ? 'success' : 'warning');
      queueReset(resultCode === 'marked' ? 2500 : 2300);
    } catch (requestError) {
      const statusCode = requestError?.response?.status;
      const message = getApiErrorMessage(requestError, 'Unable to process kiosk attendance.');

      if (statusCode === 401) {
        setStage('error');
        setStatusText('Session expired. Please sign in again.');
        playFeedbackTone('error');
        onUnauthorized?.();
        return;
      }

      if (/no face detected/i.test(message)) {
        setStage('ready');
        setStatusText(READY_MESSAGE);
        return;
      }

      setStage('failed');
      setStatusText(message);
      playFeedbackTone('error');
      queueReset();
    } finally {
      processingRef.current = false;
    }
  }, [cameraReady, captureFrame, detectorReady, mode, onUnauthorized, playFeedbackTone, queueReset, stage, token]);

  const detectFaces = useCallback(() => {
    const detector = detectorRef.current;
    const video = videoRef.current;

    if (!cameraReady || !detectorReady || !detector || !video || video.readyState < 2) {
      return;
    }

    try {
      const detections = detector.detectForVideo(video, performance.now())?.detections || [];
      const primaryFace = getPrimaryDetection(detections);
      const faceBoundingBox = primaryFace?.boundingBox;
      const viewportBox = mapBoundingBoxToViewport(faceBoundingBox, video);
      const scanBox = getScanFrameViewportBox(video, scanFrameRef.current);
      const insideScanFrame = isFaceInsideScanFrame(viewportBox, scanBox);

      if (!primaryFace || !viewportBox || !insideScanFrame) {
        missedDetectionsRef.current += 1;
        if (missedDetectionsRef.current >= MAX_MISSED_DETECTIONS) {
          stableDetectionsRef.current = 0;
          setFaceBox(null);
          if (stage === 'scanning') {
            setStage('ready');
            setStatusText(READY_MESSAGE);
          }
        }
        return;
      }

      missedDetectionsRef.current = 0;
      stableDetectionsRef.current += 1;
      setFaceBox(viewportBox);

      if (
        !processingRef.current
        && !resetTimerRef.current
        && stableDetectionsRef.current >= MIN_STABLE_DETECTIONS
        && Date.now() - lastRecognitionAtRef.current >= RECOGNITION_COOLDOWN_MS
      ) {
        lastRecognitionAtRef.current = Date.now();
        void runRecognitionCycle();
      }
    } catch {
      setStage('error');
      setStatusText('Face detection failed');
    }
  }, [cameraReady, detectorReady, runRecognitionCycle, stage]);

  useEffect(() => {
    if (!cameraReady || !detectorReady || stage === 'error') {
      return undefined;
    }

    const interval = window.setInterval(() => {
      detectFaces();
    }, DETECTION_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [cameraReady, detectFaces, detectorReady, stage]);

  return (
    <div className={`kiosk-screen kiosk-tone-${stageConfig.tone}`}>
      <div className="kiosk-mode-badge" style={{
        position: 'absolute',
        top: '1.25rem',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 20,
        padding: '0.5rem 1.25rem',
        borderRadius: '9999px',
        background: 'rgba(15, 23, 42, 0.88)',
        backdropFilter: 'blur(8px)',
        border: '1px solid rgba(255, 255, 255, 0.18)',
        color: '#ffffff',
        fontSize: '0.85rem',
        fontWeight: 600,
        letterSpacing: '0.04em',
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
      }}>
        <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: mode === 'staff' ? '#3b82f6' : '#22c55e' }} />
        {mode === 'staff' ? '👨‍🏫 STAFF BIOMETRIC KIOSK' : '🎓 STUDENT BIOMETRIC KIOSK'}
      </div>

      <button
        type="button"
        className="kiosk-exit-button"
        onClick={onUnauthorized}
        style={{
          position: 'absolute',
          top: '1.25rem',
          right: '1.5rem',
          zIndex: 30,
          padding: '0.45rem 0.95rem',
          borderRadius: '9999px',
          background: 'rgba(225, 29, 72, 0.85)',
          backdropFilter: 'blur(8px)',
          border: '1px solid rgba(255, 255, 255, 0.22)',
          color: '#ffffff',
          fontSize: '0.82rem',
          fontWeight: 600,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
        }}
        title="Exit Kiosk & Logout"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" y1="12" x2="9" y2="12" />
        </svg>
        Exit Kiosk
      </button>

      {cameraReady ? (
        <video
          ref={setVideoRef}
          className="kiosk-video"
          autoPlay
          playsInline
          muted
          onLoadedMetadata={bindVideoStream}
        />
      ) : (
        <div className="kiosk-video kiosk-video-placeholder">
          <span>{stage === 'error' ? 'Camera unavailable' : STAGE_MAP.booting.message}</span>
        </div>
      )}

      <div className="kiosk-focus-mask" aria-hidden="true">
        <span className="kiosk-mask-panel kiosk-mask-top-left" />
        <span className="kiosk-mask-panel kiosk-mask-top" />
        <span className="kiosk-mask-panel kiosk-mask-top-right" />
        <span className="kiosk-mask-panel kiosk-mask-left" />
        <span className="kiosk-mask-panel kiosk-mask-right" />
        <span className="kiosk-mask-panel kiosk-mask-bottom-left" />
        <span className="kiosk-mask-panel kiosk-mask-bottom" />
        <span className="kiosk-mask-panel kiosk-mask-bottom-right" />
      </div>
      <div ref={scanFrameRef} className={`kiosk-scan-frame kiosk-scan-frame-${stageConfig.tone}`} aria-hidden="true" />
      <canvas ref={canvasRef} className="hidden-canvas" />

      {faceBox ? (
        <div
          className={`kiosk-face-box kiosk-face-box-${stageConfig.tone}`}
          style={{
            left: `${faceBox.left}px`,
            top: `${faceBox.top}px`,
            width: `${faceBox.width}px`,
            height: `${faceBox.height}px`,
          }}
        />
      ) : null}

      <div className={`kiosk-status-bar kiosk-status-${stageConfig.tone}`}>
        <span className="kiosk-status-text">{statusText}</span>
      </div>
    </div>
  );
}
