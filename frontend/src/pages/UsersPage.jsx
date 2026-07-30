import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';
import { Camera, CheckCircle2, RefreshCw, ScanFace, UserRoundPlus } from 'lucide-react';

import { getApiErrorMessage, metaApi, usersApi } from '../api';
import { Notice, PageHeader, Panel, PasswordField } from '../components/Ui';
import { roleLabel } from '../utils';

const BLOOD_GROUP_OPTIONS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const MEDIAPIPE_ASSET_ROOT = `${import.meta.env.BASE_URL}mediapipe`;
const FACE_DETECTOR_MODEL_PATH = `${import.meta.env.BASE_URL}models/blaze_face_short_range.tflite`;
const DETECTION_INTERVAL_MS = 100;
const MIN_STABLE_POSE_FRAMES = 1;
const CAPTURE_CONFIRMATION_MS = 360;
const ANGLE_MATCH_TIMEOUT_MS = 1000;
const SIDE_YAW_THRESHOLD = 0.10;
const FRONT_YAW_THRESHOLD = 0.25;
const FRONT_PITCH_MIN = 0.15;
const FRONT_PITCH_MAX = 0.95;
const VERTICAL_PITCH_THRESHOLD = 0.04;

const STUDENT_CAPTURE_ANGLES = [
  { id: 'front', label: 'Front', instruction: 'Look straight' },
  { id: 'left', label: 'Left', instruction: 'Turn left' },
  { id: 'right', label: 'Right', instruction: 'Turn right' },
];
const STAFF_CAPTURE_ANGLES = [
  { id: 'front', label: 'Front', instruction: 'Look straight' },
  { id: 'left', label: 'Left', instruction: 'Turn left' },
  { id: 'right', label: 'Right', instruction: 'Turn right' },
];
const STUDENT_ENROLLMENT_STEPS = [
  { id: 1, title: 'Student Details', subtitle: 'Fill in the student profile' },
  { id: 2, title: 'Face Capture', subtitle: 'Capture front, left, and right' },
  { id: 3, title: 'Submit', subtitle: 'Review and complete enrollment' },
];
const STAFF_ENROLLMENT_STEPS = [
  { id: 1, title: 'Staff Details', subtitle: 'Enter essential account fields' },
  { id: 2, title: 'Face Capture', subtitle: 'Capture front, left, and right' },
  { id: 3, title: 'Submit', subtitle: 'Review and create the account' },
];

function getDefaultStudentForm(department = '') {
  return {
    name: '',
    identifier: '',
    department,
    year: '',
    semester: '',
    dob: '',
    parent_phone_number: '',
    address: '',
    blood_group: '',
  };
}

function getDefaultStaffForm(department = '', role = 'staff') {
  return {
    name: '',
    role,
    identifier: '',
    department,
    scope_year: '',
    scope_semester: '',
    is_class_advisor: false,
    password: '',
    phone_number: '',
    blood_group: '',
    address: '',
  };
}

function buildTemporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(new Uint8Array(8)) : null;
  let suffix = '';

  for (let index = 0; index < 8; index += 1) {
    const value = bytes ? bytes[index] : Math.floor(Math.random() * alphabet.length);
    suffix += alphabet[value % alphabet.length];
  }

  return `MPNM-${suffix}`;
}

function getInitialCaptureMessage(mode) {
  return mode === 'student'
    ? 'Complete the student profile to begin guided face capture.'
    : 'Complete the staff details to begin fast face enrollment.';
}

function getCaptureCompletionMessage(mode) {
  return mode === 'student'
    ? 'All required face angles have been captured. Review the record and submit enrollment.'
    : 'All required staff captures are complete. Review the account and finish creation.';
}

function EnrollmentStepper({ currentStep, steps }) {
  return (
    <div className="enrollment-stepper">
      {steps.map((step) => {
        const state = currentStep === step.id ? 'active' : currentStep > step.id ? 'complete' : 'pending';
        return (
          <div key={step.id} className={`enrollment-step enrollment-step-${state}`}>
            <div className="enrollment-step-marker">{currentStep > step.id ? <CheckCircle2 size={16} /> : step.id}</div>
            <div className="enrollment-step-copy">
              <strong>{step.title}</strong>
              <span>{step.subtitle}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CaptureProgressSteps({ activeCaptureAngles, captureEntries, currentAngle }) {
  return (
    <div className="capture-progress-strip">
      {activeCaptureAngles.map((angle) => {
        const isComplete = captureEntries.some((entry) => entry.angle === angle.id);
        const isActive = currentAngle?.id === angle.id;
        return (
          <div
            key={angle.id}
            className={`capture-progress-chip ${isComplete ? 'complete' : isActive ? 'active' : 'pending'}`}
          >
            <span>{isComplete ? 'Done' : isActive ? 'Now' : 'Next'}</span>
            <strong>{angle.label}</strong>
          </div>
        );
      })}
    </div>
  );
}

function getPrimaryDetection(detections = []) {
  if (!detections.length) {
    return null;
  }

  return [...detections].sort((left, right) => {
    const leftArea = (left.boundingBox?.width || 0) * (left.boundingBox?.height || 0);
    const rightArea = (right.boundingBox?.width || 0) * (right.boundingBox?.height || 0);
    return rightArea - leftArea;
  })[0];
}

function mapBoundingBoxToVideoViewport(boundingBox, videoElement) {
  if (!boundingBox || !videoElement?.videoWidth || !videoElement?.videoHeight) {
    return null;
  }

  const viewportWidth = videoElement.clientWidth;
  const viewportHeight = videoElement.clientHeight;
  const scale = Math.max(viewportWidth / videoElement.videoWidth, viewportHeight / videoElement.videoHeight);
  const renderedWidth = videoElement.videoWidth * scale;
  const renderedHeight = videoElement.videoHeight * scale;
  const offsetX = (viewportWidth - renderedWidth) / 2;
  const offsetY = (viewportHeight - renderedHeight) / 2;

  const left = offsetX + (boundingBox.originX * scale);
  const top = offsetY + (boundingBox.originY * scale);
  const width = boundingBox.width * scale;
  const height = boundingBox.height * scale;

  const clampedLeft = Math.max(0, Math.min(viewportWidth, left));
  const clampedTop = Math.max(0, Math.min(viewportHeight, top));
  const clampedWidth = Math.max(0, Math.min(width, viewportWidth - clampedLeft));
  const clampedHeight = Math.max(0, Math.min(height, viewportHeight - clampedTop));

  return {
    left: clampedLeft,
    top: clampedTop,
    width: clampedWidth,
    height: clampedHeight,
  };
}

function getFaceMetrics(detection, videoElement) {
  if (!detection?.boundingBox || !videoElement?.videoWidth || !videoElement?.videoHeight) {
    return null;
  }

  const keypoints = detection.keypoints || [];
  if (keypoints.length < 4) {
    return null;
  }

  const [leftEye, rightEye, noseTip, mouth] = keypoints;
  const eyeCenterX = (leftEye.x + rightEye.x) / 2;
  const eyeCenterY = (leftEye.y + rightEye.y) / 2;
  const eyeDistance = Math.abs(rightEye.x - leftEye.x);
  const mouthEyeDistance = Math.max(0.01, mouth.y - eyeCenterY);
  const score = detection.categories?.[0]?.score || 0;

  return {
    box: mapBoundingBoxToVideoViewport(detection.boundingBox, videoElement),
    yaw: (noseTip.x - eyeCenterX) / Math.max(eyeDistance, 0.001),
    pitch: (noseTip.y - eyeCenterY) / mouthEyeDistance,
    score,
  };
}

function getDirection(value) {
  if (Math.abs(value) < 0.001) {
    return 0;
  }
  return value > 0 ? 1 : -1;
}

function evaluateAngleMatch(angleId, metrics, refs) {
  if (!metrics) {
    return false;
  }

  const baselineYaw = refs.frontPoseRef.current?.yaw || 0;
  const baselinePitch = refs.frontPoseRef.current?.pitch || metrics.pitch;
  const yawDelta = metrics.yaw - baselineYaw;
  const pitchDelta = metrics.pitch - baselinePitch;

  switch (angleId) {
    case 'front':
      return Math.abs(metrics.yaw) <= FRONT_YAW_THRESHOLD && metrics.pitch >= FRONT_PITCH_MIN && metrics.pitch <= FRONT_PITCH_MAX;
    case 'left':
      return Math.abs(yawDelta) >= SIDE_YAW_THRESHOLD;
    case 'right':
      return Math.abs(yawDelta) >= SIDE_YAW_THRESHOLD
        && (refs.sideDirectionRef.current === null || getDirection(yawDelta) !== refs.sideDirectionRef.current);
    case 'up':
      return Math.abs(pitchDelta) >= VERTICAL_PITCH_THRESHOLD;
    case 'down':
      return Math.abs(pitchDelta) >= VERTICAL_PITCH_THRESHOLD
        && (refs.verticalDirectionRef.current === null || getDirection(pitchDelta) !== refs.verticalDirectionRef.current);
    default:
      return false;
  }
}

export function UsersPage({ token, user, notify }) {
  const canCreateStaff = String(user.role).toLowerCase() === 'admin';
  const preferredDepartment = user.department || '';
  const availableStaffRoles = useMemo(() => (canCreateStaff ? ['staff', 'hod', 'principal', 'admin'] : []), [canCreateStaff]);

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const detectorRef = useRef(null);
  const audioContextRef = useRef(null);
  const captureLockRef = useRef(false);
  const missedDetectionsRef = useRef(0);
  const poseStableFramesRef = useRef(0);
  const faceDetectedSinceRef = useRef(null);
  const frontPoseRef = useRef(null);
  const sideDirectionRef = useRef(null);
  const verticalDirectionRef = useRef(null);
  const captureAdvanceTimerRef = useRef(null);
  const captureFlashTimerRef = useRef(null);

  const [createMode, setCreateMode] = useState('student');
  const [meta, setMeta] = useState({ departments: [], roles: [] });
  const [studentForm, setStudentForm] = useState(getDefaultStudentForm(preferredDepartment));
  const [staffForm, setStaffForm] = useState(getDefaultStaffForm(preferredDepartment));
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [enrollmentStep, setEnrollmentStep] = useState(1);
  const [systemGeneratedPassword, setSystemGeneratedPassword] = useState(buildTemporaryPassword());
  const [captureEntries, setCaptureEntries] = useState([]);
  const [captureIndex, setCaptureIndex] = useState(0);
  const [cameraStatus, setCameraStatus] = useState('idle');
  const [captureMessage, setCaptureMessage] = useState(getInitialCaptureMessage('student'));
  const [captureError, setCaptureError] = useState('');
  const [captureIndicator, setCaptureIndicator] = useState('Automatic capture');
  const [captureTone, setCaptureTone] = useState('info');
  const [faceBox, setFaceBox] = useState(null);
  const [captureFlash, setCaptureFlash] = useState(false);
  const [autoCapturing, setAutoCapturing] = useState(false);
  const [detectorReady, setDetectorReady] = useState(false);
  const [staffScopePreview, setStaffScopePreview] = useState({
    loading: false,
    total: null,
    error: '',
  });

  const isStudentMode = createMode === 'student';
  const activeCaptureAngles = isStudentMode ? STUDENT_CAPTURE_ANGLES : STAFF_CAPTURE_ANGLES;
  const activeEnrollmentSteps = isStudentMode ? STUDENT_ENROLLMENT_STEPS : STAFF_ENROLLMENT_STEPS;
  const currentAngle = activeCaptureAngles[captureIndex] || null;
  const captureComplete = captureEntries.length === activeCaptureAngles.length;
  const cameraReady = cameraStatus === 'ready' && Boolean(streamRef.current);
  const staffDepartmentRequired = staffForm.role !== 'principal' && staffForm.role !== 'admin';
  const staffScopeRequired = staffForm.role === 'staff';
  const staffAdvisorScopeRequired = staffScopeRequired && staffForm.is_class_advisor;

  const stopCamera = useCallback(() => {
    if (captureAdvanceTimerRef.current) {
      window.clearTimeout(captureAdvanceTimerRef.current);
      captureAdvanceTimerRef.current = null;
    }
    if (captureFlashTimerRef.current) {
      window.clearTimeout(captureFlashTimerRef.current);
      captureFlashTimerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    captureLockRef.current = false;
    missedDetectionsRef.current = 0;
    poseStableFramesRef.current = 0;
    faceDetectedSinceRef.current = null;
    setAutoCapturing(false);
    setFaceBox(null);
    setCaptureFlash(false);
  }, []);

  const resetCaptureState = useCallback((mode) => {
    stopCamera();
    setEnrollmentStep(1);
    setCaptureEntries([]);
    setCaptureIndex(0);
    setCameraStatus('idle');
    setCaptureError('');
    setCaptureMessage(getInitialCaptureMessage(mode));
    setCaptureIndicator('Automatic capture');
    setCaptureTone('info');
    captureLockRef.current = false;
    missedDetectionsRef.current = 0;
    poseStableFramesRef.current = 0;
    faceDetectedSinceRef.current = null;
    frontPoseRef.current = null;
    sideDirectionRef.current = null;
    verticalDirectionRef.current = null;
  }, [stopCamera]);

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
      // Ignore autoplay race conditions and let the next render retry.
    }
  }, []);

  const setVideoRef = useCallback((node) => {
    videoRef.current = node;
    if (node && streamRef.current) {
      if (node.srcObject !== streamRef.current) {
        node.srcObject = streamRef.current;
      }
      node.play().catch(() => {});
    }
  }, []);

  const markCameraReady = useCallback((nextInstruction) => {
    setCameraStatus('ready');
    setCaptureIndicator('Automatic capture');
    setCaptureTone('info');
    setCaptureMessage(nextInstruction || 'Face capture ready');
  }, []);

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
          setCaptureError('Automatic face detector loading failed. Manual capture mode is ready.');
          setCameraStatus('ready');
          setCaptureIndicator('Manual capture mode');
        }
      }
    }

    initializeFaceDetector();

    return () => {
      cancelled = true;
      detectorRef.current?.close?.();
      detectorRef.current = null;
      if (audioContextRef.current && typeof audioContextRef.current.close === 'function') {
        audioContextRef.current.close().catch(() => {});
        audioContextRef.current = null;
      }
    };
  }, []);

  const triggerCaptureFlash = useCallback(() => {
    if (captureFlashTimerRef.current) {
      window.clearTimeout(captureFlashTimerRef.current);
    }
    setCaptureFlash(true);
    captureFlashTimerRef.current = window.setTimeout(() => {
      setCaptureFlash(false);
      captureFlashTimerRef.current = null;
    }, 180);
  }, []);

  const playCaptureTone = useCallback(async () => {
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

      const oscillator = context.createOscillator();
      const gainNode = context.createGain();
      const startAt = context.currentTime;
      const stopAt = startAt + 0.09;

      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(900, startAt);
      gainNode.gain.setValueAtTime(0.0001, startAt);
      gainNode.gain.exponentialRampToValueAtTime(0.055, startAt + 0.01);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, stopAt);

      oscillator.connect(gainNode);
      gainNode.connect(context.destination);
      oscillator.start(startAt);
      oscillator.stop(stopAt);
    } catch {
      // Ignore audio failures so enrollment can continue smoothly.
    }
  }, []);

  const resetStudentEnrollment = useCallback((department = preferredDepartment || meta.departments?.[0] || '') => {
    resetCaptureState('student');
    setStudentForm(getDefaultStudentForm(department));
    setSystemGeneratedPassword(buildTemporaryPassword());
  }, [meta.departments, preferredDepartment, resetCaptureState]);

  const resetStaffEnrollment = useCallback((department = preferredDepartment || meta.departments?.[0] || '', role = availableStaffRoles[0] || 'staff') => {
    resetCaptureState('staff');
    setStaffForm(getDefaultStaffForm(department, role));
  }, [availableStaffRoles, meta.departments, preferredDepartment, resetCaptureState]);

  const handleCreateModeChange = useCallback((nextMode) => {
    if (nextMode === createMode) {
      return;
    }

    resetCaptureState(nextMode);
    setCreateMode(nextMode);
  }, [createMode, resetCaptureState]);

  useEffect(() => {
    let ignore = false;

    async function loadMeta() {
      try {
        const response = await metaApi.options(token);
        if (!ignore) {
          const nextDepartment = preferredDepartment || response.departments?.[0] || '';
          setMeta(response);
          setStudentForm((current) => ({ ...current, department: current.department || nextDepartment }));
          setStaffForm((current) => ({ ...current, department: current.department || nextDepartment }));
        }
      } catch {
        // Keep the form usable even if option metadata fails to load.
      }
    }

    loadMeta();
    return () => {
      ignore = true;
    };
  }, [preferredDepartment, token]);

  useEffect(() => {
    let ignore = false;

    async function loadStaffScopePreview() {
      if (!canCreateStaff || !staffAdvisorScopeRequired) {
        setStaffScopePreview({
          loading: false,
          total: null,
          error: '',
        });
        return;
      }

      if (!String(staffForm.department || '').trim() || !String(staffForm.scope_year || '').trim() || !String(staffForm.scope_semester || '').trim()) {
        setStaffScopePreview({
          loading: false,
          total: null,
          error: '',
        });
        return;
      }

      setStaffScopePreview((current) => ({
        ...current,
        loading: true,
        error: '',
      }));

      try {
        const response = await usersApi.list(token, {
          page: 1,
          page_size: 1,
          role: 'student',
          department: staffForm.department,
          year: Number(staffForm.scope_year),
          semester: Number(staffForm.scope_semester),
        });

        if (!ignore) {
          setStaffScopePreview({
            loading: false,
            total: Number(response.total || 0),
            error: '',
          });
        }
      } catch (requestError) {
        if (!ignore) {
          setStaffScopePreview({
            loading: false,
            total: null,
            error: getApiErrorMessage(requestError, 'Unable to verify the selected advisor scope right now.'),
          });
        }
      }
    }

    loadStaffScopePreview();
    return () => {
      ignore = true;
    };
  }, [
    canCreateStaff,
    staffAdvisorScopeRequired,
    staffForm.department,
    staffForm.scope_semester,
    staffForm.scope_year,
    token,
  ]);

  useEffect(() => {
    if (!canCreateStaff) {
      if (createMode !== 'student') {
        resetCaptureState('student');
      }
      setCreateMode('student');
      return;
    }

    setStaffForm((current) => ({
      ...current,
      role: availableStaffRoles.includes(current.role) ? current.role : availableStaffRoles[0] || 'staff',
    }));
  }, [availableStaffRoles, canCreateStaff, createMode, resetCaptureState]);

  const startCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus('error');
      setCaptureError('This browser does not support camera capture.');
      setCaptureTone('danger');
      return;
    }

    try {
      setCameraStatus('starting');
      setCaptureError('');
      setCaptureTone('info');
      setCaptureIndicator('Opening camera');
      setCaptureMessage('Prepare for guided face capture');
      stopCamera();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      });

      stream.getVideoTracks().forEach((track) => {
        track.enabled = true;
      });

      streamRef.current = stream;
      bindVideoStream();

      if (detectorReady) {
        markCameraReady(currentAngle?.instruction);
      } else {
        setCameraStatus('starting');
        setCaptureIndicator('Preparing detector');
        setCaptureMessage('Camera ready');
      }
    } catch {
      setCameraStatus('error');
      setCaptureError('Camera permission was blocked or no webcam is available.');
      setCaptureTone('danger');
    }
  }, [bindVideoStream, currentAngle, detectorReady, markCameraReady, stopCamera]);

  useEffect(() => {
    if (enrollmentStep === 2) {
      startCamera();
      return () => stopCamera();
    }

    stopCamera();
    return undefined;
  }, [enrollmentStep, startCamera, stopCamera]);

  useEffect(() => {
    if (cameraStatus === 'starting' || cameraStatus === 'ready' || cameraStatus === 'capturing' || cameraStatus === 'complete') {
      bindVideoStream();
    }
  }, [bindVideoStream, cameraStatus]);

  useEffect(() => {
    if (enrollmentStep === 2 && detectorReady && (cameraStatus === 'starting' || cameraStatus === 'idle')) {
      markCameraReady(currentAngle?.instruction);
    }
  }, [cameraStatus, currentAngle, detectorReady, enrollmentStep, markCameraReady]);

  useEffect(() => {
    faceDetectedSinceRef.current = null;
    missedDetectionsRef.current = 0;
    poseStableFramesRef.current = 0;
  }, [currentAngle?.id, enrollmentStep]);

  const captureFrame = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) {
      return null;
    }

    const video = videoRef.current;
    if (video.readyState < 2) {
      return null;
    }

    const canvas = canvasRef.current;
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const context = canvas.getContext('2d');
    if (!context) {
      return null;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.9);
  }, []);

  const handleAutoCapture = useCallback(async (metrics) => {
    if (!currentAngle || captureLockRef.current) {
      return;
    }

    const imageBase64 = captureFrame();
    if (!imageBase64) {
      setCaptureTone('info');
      setCaptureIndicator('Waiting for a stable camera feed');
      setCaptureMessage(currentAngle.instruction);
      return;
    }

    captureLockRef.current = true;
    setAutoCapturing(true);
    setCameraStatus('capturing');
    setCaptureError('');
    setCaptureTone('info');
    setCaptureIndicator('Capturing...');
    setCaptureMessage('Capturing...');

    try {
      const response = await usersApi.extractFaceEmbedding(token, imageBase64);
      const nextEntry = {
        angle: currentAngle.id,
        label: currentAngle.label,
        image: imageBase64,
        embedding: response.embedding,
      };

      if (currentAngle.id === 'front' && metrics) {
        frontPoseRef.current = {
          yaw: metrics.yaw,
          pitch: metrics.pitch,
        };
      }

      if (currentAngle.id === 'left' && metrics) {
        const yawDelta = metrics.yaw - (frontPoseRef.current?.yaw || 0);
        sideDirectionRef.current = getDirection(yawDelta || metrics.yaw);
      }

      if (currentAngle.id === 'up' && metrics) {
        const baselinePitch = frontPoseRef.current?.pitch || metrics.pitch;
        verticalDirectionRef.current = getDirection((metrics.pitch - baselinePitch) || metrics.pitch);
      }

      setCaptureEntries((current) => [...current, nextEntry]);
      setFaceBox(metrics?.box || null);
      setCaptureTone('success');
      setCaptureIndicator(`${currentAngle.label} captured`);
      setCaptureMessage('Captured');
      triggerCaptureFlash();
      playCaptureTone();

      if (captureAdvanceTimerRef.current) {
        window.clearTimeout(captureAdvanceTimerRef.current);
      }

      if (captureIndex >= activeCaptureAngles.length - 1) {
        setCaptureIndicator(`${activeCaptureAngles.length} / ${activeCaptureAngles.length} captured`);
        captureAdvanceTimerRef.current = window.setTimeout(() => {
          setCameraStatus('complete');
          setCaptureMessage(getCaptureCompletionMessage(createMode));
          setEnrollmentStep(3);
          captureAdvanceTimerRef.current = null;
        }, CAPTURE_CONFIRMATION_MS);
      } else {
        const nextAngle = activeCaptureAngles[captureIndex + 1];
        captureAdvanceTimerRef.current = window.setTimeout(() => {
          poseStableFramesRef.current = 0;
          missedDetectionsRef.current = 0;
          faceDetectedSinceRef.current = null;
          setCaptureIndex((current) => current + 1);
          setCameraStatus('ready');
          setCaptureTone('info');
          setCaptureIndicator(`${captureIndex + 1} / ${activeCaptureAngles.length} captured`);
          setCaptureMessage(nextAngle.instruction);
          captureAdvanceTimerRef.current = null;
        }, CAPTURE_CONFIRMATION_MS);
      }
    } catch (requestError) {
      const nextMessage = getApiErrorMessage(requestError, `No face detected for ${currentAngle.label}.`);
      poseStableFramesRef.current = 0;
      faceDetectedSinceRef.current = null;
      setCameraStatus('ready');
      setCaptureTone('danger');
      setCaptureIndicator(nextMessage);
      setCaptureMessage(currentAngle.instruction);
    } finally {
      setAutoCapturing(false);
      captureLockRef.current = false;
    }
  }, [
    activeCaptureAngles,
    captureFrame,
    captureIndex,
    createMode,
    currentAngle,
    playCaptureTone,
    token,
    triggerCaptureFlash,
  ]);

  useEffect(() => {
    if (
      enrollmentStep !== 2
      || cameraStatus !== 'ready'
      || autoCapturing
      || captureComplete
      || !currentAngle
      || !detectorReady
    ) {
      return undefined;
    }

    let cancelled = false;
    let frameId = 0;
    let lastDetectionAt = 0;

    const runDetectionLoop = () => {
      if (cancelled) {
        return;
      }

      frameId = window.requestAnimationFrame(runDetectionLoop);

      const videoElement = videoRef.current;
      const detector = detectorRef.current;

      if (!videoElement || !detector || videoElement.readyState < 2 || captureLockRef.current) {
        return;
      }

      const now = performance.now();
      if (now - lastDetectionAt < DETECTION_INTERVAL_MS) {
        return;
      }
      lastDetectionAt = now;

      try {
        const result = detector.detectForVideo(videoElement, now);
        const detection = getPrimaryDetection(result?.detections);

        if (!detection) {
          missedDetectionsRef.current += 1;
          poseStableFramesRef.current = 0;

          if (missedDetectionsRef.current >= 2) {
            setFaceBox(null);
            faceDetectedSinceRef.current = null;
          }

          setCaptureTone('info');
          setCaptureIndicator('Searching for face');
          setCaptureMessage(currentAngle.instruction);
          return;
        }

        missedDetectionsRef.current = 0;
        if (faceDetectedSinceRef.current === null) {
          faceDetectedSinceRef.current = now;
        }

        const detectedBox = mapBoundingBoxToVideoViewport(detection.boundingBox, videoElement);
        setFaceBox(detectedBox || null);

        const metrics = getFaceMetrics(detection, videoElement);
        const matchedAngle = evaluateAngleMatch(currentAngle.id, metrics, {
          frontPoseRef,
          sideDirectionRef,
          verticalDirectionRef,
        });
        const timeoutReached = faceDetectedSinceRef.current !== null
          && now - faceDetectedSinceRef.current >= ANGLE_MATCH_TIMEOUT_MS;

        if (!matchedAngle) {
          poseStableFramesRef.current = 0;

          if (timeoutReached) {
            setCaptureTone('info');
            setCaptureIndicator('Capturing...');
            setCaptureMessage(currentAngle.instruction);
            handleAutoCapture(metrics);
            return;
          }

          setCaptureTone('info');
          setCaptureIndicator('Hold still...');
          setCaptureMessage(currentAngle.instruction);
          return;
        }

        poseStableFramesRef.current += 1;
        setCaptureTone('info');
        setCaptureIndicator(`Hold still... ${poseStableFramesRef.current}/${MIN_STABLE_POSE_FRAMES}`);
        setCaptureMessage(currentAngle.instruction);

        if (poseStableFramesRef.current >= MIN_STABLE_POSE_FRAMES) {
          poseStableFramesRef.current = 0;
          handleAutoCapture(metrics);
        }
      } catch {
        setCaptureTone('danger');
        setCaptureIndicator('Face detection unavailable');
        setCaptureError('Automatic face detection is unavailable on this device.');
      }
    };

    frameId = window.requestAnimationFrame(runDetectionLoop);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
    };
  }, [autoCapturing, cameraStatus, captureComplete, currentAngle, detectorReady, enrollmentStep, handleAutoCapture]);

  useEffect(() => () => stopCamera(), [stopCamera]);

  async function handleCreateStaff(event) {
    event.preventDefault();
    if (!captureComplete) {
      return;
    }

    setFormSubmitting(true);

    try {
      const classAssignments = staffAdvisorScopeRequired
        ? [
            {
              department: staffForm.department.trim(),
              year: Number(staffForm.scope_year),
              semester: Number(staffForm.scope_semester),
              assignment_type: 'class_advisor',
            },
          ]
        : [];

      const payload = {
        name: staffForm.name.trim(),
        role: staffForm.role,
        identifier: staffForm.identifier.trim(),
        department: staffDepartmentRequired ? staffForm.department.trim() : null,
        password: staffForm.password,
        address: staffForm.address.trim() || null,
        blood_group: staffForm.blood_group || null,
        phone_number: staffForm.phone_number.trim(),
        year: null,
        semester: null,
        class_assignments: classAssignments,
        embeddings: captureEntries.map((entry) => entry.embedding),
        face_samples: captureEntries.map((entry) => ({
          angle: entry.angle,
          image_base64: entry.image,
        })),
      };

      await usersApi.create(token, payload);
      notify('success', 'Staff account created', `${staffForm.name} has been added with face enrollment and is ready for attendance.`);
      resetStaffEnrollment(preferredDepartment || meta.departments?.[0] || '', availableStaffRoles[0] || 'staff');
    } catch (requestError) {
      notify('danger', 'Create staff failed', getApiErrorMessage(requestError, 'Unable to save the staff account.'));
    } finally {
      setFormSubmitting(false);
    }
  }

  function handleProceedToCapture(event) {
    event.preventDefault();
    captureLockRef.current = false;
    missedDetectionsRef.current = 0;
    poseStableFramesRef.current = 0;
    frontPoseRef.current = null;
    sideDirectionRef.current = null;
    verticalDirectionRef.current = null;
    setEnrollmentStep(2);
    setCaptureIndex(0);
    setCaptureEntries([]);
    setCaptureError('');
    setCameraStatus('starting');
    setCaptureIndicator('Preparing camera');
    setCaptureTone('info');
    setFaceBox(null);
    setCaptureMessage(activeCaptureAngles[0].instruction);
  }

  function handleBackToDetails() {
    resetCaptureState(createMode);
  }

  function handleEditDetails() {
    setEnrollmentStep(1);
  }

  function handleRetakeCaptures() {
    captureLockRef.current = false;
    missedDetectionsRef.current = 0;
    poseStableFramesRef.current = 0;
    frontPoseRef.current = null;
    sideDirectionRef.current = null;
    verticalDirectionRef.current = null;
    setEnrollmentStep(2);
    setCaptureEntries([]);
    setCaptureIndex(0);
    setCaptureError('');
    setCameraStatus('starting');
    setCaptureIndicator('Restarting capture');
    setCaptureTone('info');
    setFaceBox(null);
    setCaptureMessage(activeCaptureAngles[0].instruction);
  }

  async function handleCreateStudent(event) {
    event.preventDefault();
    if (!captureComplete) {
      return;
    }

    setFormSubmitting(true);

    try {
      const payload = {
        name: studentForm.name,
        role: 'student',
        identifier: studentForm.identifier.trim(),
        department: studentForm.department.trim(),
        year: Number(studentForm.year),
        semester: Number(studentForm.semester),
        dob: studentForm.dob,
        address: studentForm.address.trim(),
        blood_group: studentForm.blood_group,
        parent_phone_number: studentForm.parent_phone_number.trim(),
        password: systemGeneratedPassword,
        embeddings: captureEntries.map((entry) => entry.embedding),
        face_samples: captureEntries.map((entry) => ({
          angle: entry.angle,
          image_base64: entry.image,
        })),
      };

      await usersApi.create(token, payload);
      notify(
        'success',
        'Student enrolled',
        `${studentForm.name} has been enrolled successfully and can access the student portal using the register number.`
      );
      resetStudentEnrollment(preferredDepartment || meta.departments?.[0] || '');
    } catch (requestError) {
      notify('danger', 'Enrollment failed', getApiErrorMessage(requestError, 'Unable to complete student enrollment.'));
    } finally {
      setFormSubmitting(false);
    }
  }

  const studentDetailCompletion = [
    studentForm.name,
    studentForm.identifier,
    studentForm.department,
    studentForm.year,
    studentForm.semester,
    studentForm.dob,
    studentForm.parent_phone_number,
    studentForm.address,
    studentForm.blood_group,
  ].every((value) => String(value || '').trim());

  const staffDetailCompletion = [
    staffForm.name,
    staffForm.role,
    staffForm.identifier,
    staffForm.password,
    staffForm.phone_number,
  ].every((value) => String(value || '').trim())
    && (!staffDepartmentRequired || String(staffForm.department || '').trim())
    && (!staffAdvisorScopeRequired || [
      staffForm.scope_year,
      staffForm.scope_semester,
    ].every((value) => String(value || '').trim()));

  const showCaptureVideo = cameraStatus === 'starting' || cameraStatus === 'ready' || cameraStatus === 'capturing' || cameraStatus === 'complete';
  const captureStepContent = enrollmentStep === 2 ? (
    <div className={`capture-stage-flow capture-tone-${captureTone}`}>
      {captureError && cameraStatus === 'error' ? (
        <Notice tone="danger" title="Camera access issue">
          {captureError}
        </Notice>
      ) : null}

      <CaptureProgressSteps
        activeCaptureAngles={activeCaptureAngles}
        captureEntries={captureEntries}
        currentAngle={currentAngle}
      />

      <div className="capture-stage-shell">
        <div className="scanner-shell enrollment-scanner-shell capture-camera-stage">
          {showCaptureVideo ? (
            <video
              ref={setVideoRef}
              className="scanner-video"
              autoPlay
              playsInline
              muted
              onLoadedMetadata={bindVideoStream}
            />
          ) : (
            <div className="scanner-placeholder">
              {cameraStatus === 'error' ? <Camera size={44} /> : <ScanFace size={44} />}
              <p>{captureError || captureIndicator}</p>
            </div>
          )}

          <div className="capture-camera-wash" />

          {showCaptureVideo && !captureError ? (
            <div className="capture-instruction-overlay">
              <strong>{captureMessage}</strong>
            </div>
          ) : null}

          <div className={`capture-indicator-pill capture-indicator-${captureTone}`}>
            {captureError || captureIndicator}
          </div>

          {faceBox ? (
            <div
              className={`capture-face-box capture-face-box-${captureTone}`}
              style={{
                left: `${faceBox.left}px`,
                top: `${faceBox.top}px`,
                width: `${faceBox.width}px`,
                height: `${faceBox.height}px`,
              }}
            />
          ) : null}

          {captureFlash ? <div className="capture-flash-overlay" /> : null}
        </div>
        <canvas ref={canvasRef} className="hidden-canvas" />
      </div>

      <div className="capture-toolbar">
        <button type="button" className="btn-secondary" onClick={handleBackToDetails} disabled={autoCapturing}>
          Back to Details
        </button>
        <button type="button" className="btn-secondary" onClick={startCamera} disabled={autoCapturing}>
          <RefreshCw size={16} />
          Restart Camera
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={() => handleAutoCapture(null)}
          disabled={autoCapturing || !cameraReady}
        >
          <Camera size={16} />
          Capture {currentAngle?.label || 'Face'} Now
        </button>
      </div>
    </div>
  ) : null;

  return (
    <div className="page-stack">
      <PageHeader
        title="Enrollment & Identity"
        subtitle="Manage student and staff enrollment, biometric face registration, and identity readiness from one professional workspace."
      />

      {canCreateStaff ? (
        <div className="user-mode-switch">
          <button
            type="button"
            className={`user-mode-pill ${createMode === 'student' ? 'active' : ''}`}
            onClick={() => handleCreateModeChange('student')}
          >
            <UserRoundPlus size={16} />
            Student Enrollment
          </button>
          <button
            type="button"
            className={`user-mode-pill ${createMode === 'staff' ? 'active' : ''}`}
            onClick={() => handleCreateModeChange('staff')}
          >
            <ScanFace size={16} />
            Staff Enrollment
          </button>
        </div>
      ) : null}

      <Panel
        title={createMode === 'student' ? 'Student Enrollment' : 'Staff Account Creation'}
        subtitle={
          createMode === 'student'
            ? 'A guided 3-step enrollment flow for student identity details, multi-angle face capture, and final submission.'
            : 'A fast 3-step workflow for essential staff details, guided face capture, and attendance-ready account creation.'
        }
      >
        {createMode === 'student' ? (
          <div className="enrollment-flow">
            <EnrollmentStepper currentStep={enrollmentStep} steps={activeEnrollmentSteps} />

            {enrollmentStep === 1 ? (
              <form className="form-grid" onSubmit={handleProceedToCapture}>
                <div className="details-grid">
                  <label className="field">
                    <span>Full Name</span>
                    <input className="input" value={studentForm.name} onChange={(event) => setStudentForm((current) => ({ ...current, name: event.target.value }))} required />
                  </label>
                  <label className="field">
                    <span>Register Number</span>
                    <input className="input" value={studentForm.identifier} onChange={(event) => setStudentForm((current) => ({ ...current, identifier: event.target.value }))} required />
                  </label>
                  <label className="field">
                    <span>Department</span>
                    <select
                      className="input"
                      value={studentForm.department}
                      onChange={(event) => setStudentForm((current) => ({ ...current, department: event.target.value }))}
                      required
                    >
                      <option value="" disabled hidden>Select department</option>
                      {meta.departments.map((department) => (
                        <option key={department} value={department}>{department}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Year</span>
                    <input className="input" type="number" min="1" max="4" value={studentForm.year} onChange={(event) => setStudentForm((current) => ({ ...current, year: event.target.value }))} required />
                  </label>
                  <label className="field">
                    <span>Semester</span>
                    <input className="input" type="number" min="1" max="8" value={studentForm.semester} onChange={(event) => setStudentForm((current) => ({ ...current, semester: event.target.value }))} required />
                  </label>
                  <label className="field">
                    <span>DOB</span>
                    <input className="input" type="date" value={studentForm.dob} onChange={(event) => setStudentForm((current) => ({ ...current, dob: event.target.value }))} required />
                  </label>
                  <label className="field">
                    <span>Parent Phone</span>
                    <input
                      className="input"
                      type="tel"
                      value={studentForm.parent_phone_number}
                      onChange={(event) => setStudentForm((current) => ({ ...current, parent_phone_number: event.target.value }))}
                      placeholder="e.g. 9876543210"
                      required
                    />
                  </label>
                  <label className="field">
                    <span>Blood Group</span>
                    <input
                      className="input"
                      type="text"
                      list="blood-groups"
                      value={studentForm.blood_group}
                      onChange={(event) => setStudentForm((current) => ({ ...current, blood_group: event.target.value.toUpperCase() }))}
                      placeholder="e.g. O+"
                      required
                    />
                  </label>
                  <label className="field field-span-2">
                    <span>Address</span>
                    <textarea className="input input-textarea" value={studentForm.address} onChange={(event) => setStudentForm((current) => ({ ...current, address: event.target.value }))} rows={4} required />
                  </label>
                </div>

                <Notice tone="info" title="Portal access">
                  Student portal access is mapped to the register number. Final submission stays locked until all required face angles are captured.
                </Notice>

                <div className="enrollment-actions">
                  <button type="submit" className="btn-primary" disabled={!studentDetailCompletion}>
                    Next: Face Capture
                  </button>
                </div>
              </form>
            ) : null}

            {captureStepContent}

            {enrollmentStep === 3 ? (
              <form className="form-grid" onSubmit={handleCreateStudent}>
                <Notice tone="success" title="Face capture complete">
                  All required angles are captured. Review the enrollment data below and submit to create the student record with face enrollment.
                </Notice>

                <div className="enrollment-review-grid">
                  <div className="enrollment-summary-card">
                    <h3>Student Summary</h3>
                    <div className="profile-list">
                      <div><span>Full Name</span><strong>{studentForm.name}</strong></div>
                      <div><span>Register Number</span><strong>{studentForm.identifier}</strong></div>
                      <div><span>Department</span><strong>{studentForm.department}</strong></div>
                      <div><span>Year / Semester</span><strong>{studentForm.year} / {studentForm.semester}</strong></div>
                      <div><span>DOB</span><strong>{studentForm.dob}</strong></div>
                      <div><span>Parent Phone</span><strong>{studentForm.parent_phone_number}</strong></div>
                      <div><span>Blood Group</span><strong>{studentForm.blood_group}</strong></div>
                    </div>
                  </div>

                  <div className="enrollment-summary-card">
                    <h3>Enrollment Completion</h3>
                    <div className="profile-list">
                      <div><span>Face Angles Captured</span><strong>{captureEntries.length} / {activeCaptureAngles.length}</strong></div>
                      <div><span>Portal Access</span><strong>Register number only</strong></div>
                      <div><span>Submission State</span><strong>{captureComplete ? 'Ready to submit' : 'Capture incomplete'}</strong></div>
                    </div>
                    <p className="enrollment-summary-copy">Create the student record to save the profile and face enrollment together. After enrollment, the student portal can be opened with the register number.</p>
                  </div>
                </div>

                <div className="capture-preview-grid">
                  {captureEntries.map((entry) => (
                    <div key={entry.angle} className="capture-preview-card">
                      <img src={entry.image} alt={`${entry.label} capture`} />
                      <strong>{entry.label}</strong>
                    </div>
                  ))}
                </div>

                <div className="enrollment-actions">
                  <button type="button" className="btn-secondary" onClick={handleEditDetails} disabled={formSubmitting}>
                    Edit Details
                  </button>
                  <button type="button" className="btn-secondary" onClick={handleRetakeCaptures} disabled={formSubmitting}>
                    Retake Face Capture
                  </button>
                  <button type="submit" className="btn-primary" disabled={!captureComplete || formSubmitting}>
                    {formSubmitting ? 'Submitting Enrollment...' : 'Submit Student Enrollment'}
                  </button>
                </div>
              </form>
            ) : null}
          </div>
        ) : (
          <div className="enrollment-flow">
            <EnrollmentStepper currentStep={enrollmentStep} steps={activeEnrollmentSteps} />

            {enrollmentStep === 1 ? (
              <form className="form-grid form-grid-compact" onSubmit={handleProceedToCapture}>
                <div className="details-grid details-grid-compact">
                  <label className="field">
                    <span>Full Name</span>
                    <input className="input" value={staffForm.name} onChange={(event) => setStaffForm((current) => ({ ...current, name: event.target.value }))} required />
                  </label>
                  <label className="field">
                    <span>Role</span>
                    <select
                      className="input"
                      value={staffForm.role}
                      onChange={(event) => setStaffForm((current) => ({
                        ...current,
                        role: event.target.value,
                        department: ['principal', 'admin'].includes(event.target.value)
                          ? ''
                          : (current.department || preferredDepartment || meta.departments?.[0] || ''),
                        is_class_advisor: event.target.value === 'staff' ? current.is_class_advisor : false,
                        ...(event.target.value === 'staff' ? {} : { scope_year: '', scope_semester: '' }),
                      }))}
                    >
                      {availableStaffRoles.map((role) => (
                        <option key={role} value={role}>{roleLabel(role)}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Email / Identifier</span>
                    <input
                      className="input"
                      value={staffForm.identifier}
                      onChange={(event) => setStaffForm((current) => ({ ...current, identifier: event.target.value }))}
                      placeholder="staff@institution.edu"
                      required
                    />
                  </label>
                  {staffDepartmentRequired ? (
                    <label className="field">
                      <span>Department</span>
                      <select
                        className="input"
                        value={staffForm.department}
                        onChange={(event) => setStaffForm((current) => ({ ...current, department: event.target.value }))}
                        required
                      >
                        <option value="" hidden>Select department</option>
                        {meta.departments.map((department) => (
                          <option key={department} value={department}>{department}</option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <label className="field">
                    <span>Password</span>
                    <PasswordField
                      className="input"
                      minLength="6"
                      value={staffForm.password}
                      onChange={(event) => setStaffForm((current) => ({ ...current, password: event.target.value }))}
                      required
                    />
                  </label>
                  <label className="field">
                    <span>Phone Number</span>
                    <input
                      className="input"
                      type="tel"
                      value={staffForm.phone_number}
                      onChange={(event) => setStaffForm((current) => ({ ...current, phone_number: event.target.value }))}
                      placeholder="e.g. 9876543210"
                      required
                    />
                  </label>
                  {staffScopeRequired ? (
                    <>
                      <label className="field">
                        <span>Class Advisor Access</span>
                        <select
                          className="input"
                          value={staffForm.is_class_advisor ? 'yes' : 'no'}
                          onChange={(event) => setStaffForm((current) => ({ ...current, is_class_advisor: event.target.value === 'yes' }))}
                        >
                          <option value="no">No</option>
                          <option value="yes">Yes</option>
                        </select>
                      </label>
                      {staffForm.is_class_advisor ? (
                        <>
                          <label className="field">
                            <span>Attendance Year</span>
                            <input
                              className="input"
                              type="number"
                              min="1"
                              max="4"
                              value={staffForm.scope_year}
                              onChange={(event) => setStaffForm((current) => ({ ...current, scope_year: event.target.value }))}
                              required
                            />
                          </label>
                          <label className="field">
                            <span>Attendance Semester</span>
                            <input
                              className="input"
                              type="number"
                              min="1"
                              max="8"
                              value={staffForm.scope_semester}
                              onChange={(event) => setStaffForm((current) => ({ ...current, scope_semester: event.target.value }))}
                              required
                            />
                          </label>
                        </>
                      ) : null}
                    </>
                  ) : null}
                  {staffAdvisorScopeRequired && staffScopePreview.total !== null ? (
                    <div className="field field-span-2">
                      <Notice
                        tone={staffScopePreview.total > 0 ? 'success' : 'warning'}
                        title="Advisor Scope Preview"
                      >
                        {staffScopePreview.total > 0
                          ? `${staffScopePreview.total} student record(s) currently match ${staffForm.department} / Year ${staffForm.scope_year} / Sem ${staffForm.scope_semester}.`
                          : `No student records currently match ${staffForm.department} / Year ${staffForm.scope_year} / Sem ${staffForm.scope_semester}.`}
                      </Notice>
                    </div>
                  ) : null}
                  {staffAdvisorScopeRequired && staffScopePreview.error ? (
                    <div className="field field-span-2">
                      <Notice tone="warning" title="Advisor Scope Preview">
                        {staffScopePreview.error}
                      </Notice>
                    </div>
                  ) : null}
                  <label className="field">
                    <span>Blood Group</span>
                    <input
                      className="input"
                      type="text"
                      list="blood-groups"
                      value={staffForm.blood_group}
                      onChange={(event) => setStaffForm((current) => ({ ...current, blood_group: event.target.value.toUpperCase() }))}
                      placeholder="e.g. O+ (optional)"
                    />
                    <datalist id="blood-groups">
                      {BLOOD_GROUP_OPTIONS.map((group) => (
                        <option key={group} value={group} />
                      ))}
                    </datalist>
                  </label>
                  <label className="field field-span-2">
                    <span>Address</span>
                    <textarea
                      className="input input-textarea input-textarea-compact"
                      value={staffForm.address}
                      onChange={(event) => setStaffForm((current) => ({ ...current, address: event.target.value }))}
                      rows={3}
                      placeholder="Optional contact address"
                    />
                  </label>
                </div>

                <Notice tone="info" title="Fast staff enrollment">
                  All staff accounts can be enrolled here. Enable `Class Advisor Access` only for staff members who should manage a specific class. Plain staff accounts keep personal dashboard access without year and semester scope.
                </Notice>

                <div className="enrollment-actions">
                  <button type="submit" className="btn-primary" disabled={!staffDetailCompletion}>
                    Next: Face Capture
                  </button>
                </div>
              </form>
            ) : null}

            {captureStepContent}

            {enrollmentStep === 3 ? (
              <form className="form-grid" onSubmit={handleCreateStaff}>
                <Notice tone="success" title="Staff face capture complete">
                  All 3 staff angles are captured. Review the record below and create the account to enable immediate face-based attendance.
                </Notice>

                <div className="enrollment-review-grid">
                  <div className="enrollment-summary-card">
                    <h3>Staff Summary</h3>
                    <div className="profile-list">
                      <div><span>Full Name</span><strong>{staffForm.name}</strong></div>
                      <div><span>Role</span><strong>{roleLabel(staffForm.role)}</strong></div>
                      <div><span>Identifier</span><strong>{staffForm.identifier}</strong></div>
                      {staffDepartmentRequired ? (
                        <div><span>Department</span><strong>{staffForm.department}</strong></div>
                      ) : null}
                      <div><span>Attendance Scope</span><strong>{staffAdvisorScopeRequired ? `${staffForm.department} / Year ${staffForm.scope_year} / Sem ${staffForm.scope_semester}` : 'Personal dashboard only'}</strong></div>
                      <div><span>Class Advisor Access</span><strong>{staffScopeRequired ? (staffForm.is_class_advisor ? 'Enabled' : 'No') : 'Not applicable'}</strong></div>
                      <div><span>Phone Number</span><strong>{staffForm.phone_number}</strong></div>
                      <div><span>Blood Group</span><strong>{staffForm.blood_group || 'Not provided'}</strong></div>
                    </div>
                  </div>

                  <div className="enrollment-summary-card">
                    <h3>Enrollment Completion</h3>
                    <div className="profile-list">
                      <div><span>Face Angles Captured</span><strong>{captureEntries.length} / {activeCaptureAngles.length}</strong></div>
                      <div><span>Submission State</span><strong>{captureComplete ? 'Ready to submit' : 'Capture incomplete'}</strong></div>
                      <div><span>Attendance Ready</span><strong>{captureComplete ? 'Yes' : 'No'}</strong></div>
                    </div>
                    <p className="enrollment-summary-copy">Create the account to save the staff details and face embeddings together, without any extra upload or follow-up step.</p>
                  </div>
                </div>

                <div className="capture-preview-grid">
                  {captureEntries.map((entry) => (
                    <div key={entry.angle} className="capture-preview-card">
                      <img src={entry.image} alt={`${entry.label} capture`} />
                      <strong>{entry.label}</strong>
                    </div>
                  ))}
                </div>

                <div className="enrollment-actions">
                  <button type="button" className="btn-secondary" onClick={handleEditDetails} disabled={formSubmitting}>
                    Edit Details
                  </button>
                  <button type="button" className="btn-secondary" onClick={handleRetakeCaptures} disabled={formSubmitting}>
                    Retake Face Capture
                  </button>
                  <button type="submit" className="btn-primary" disabled={!captureComplete || formSubmitting}>
                    {formSubmitting ? 'Creating Staff Account...' : 'Create Staff Account'}
                  </button>
                </div>
              </form>
            ) : null}
          </div>
        )}
      </Panel>

    </div>
  );
}
