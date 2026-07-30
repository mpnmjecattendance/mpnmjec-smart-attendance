import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, LoaderCircle, RefreshCw } from 'lucide-react';

import { attendanceApi, getApiErrorMessage } from '../api';
import { Notice, PageHeader, Panel, StatusBadge } from '../components/Ui';
import { formatPercent } from '../utils';

const stageMap = {
  idle: { label: 'Waiting for camera', tone: 'neutral' },
  ready: { label: 'Camera ready', tone: 'success' },
  analyzing: { label: 'Scanning face', tone: 'info' },
  detected: { label: 'Face detected', tone: 'info' },
  recognized: { label: 'Recognized', tone: 'success' },
  marked: { label: 'Marked present', tone: 'success' },
  duplicate: { label: 'Already marked', tone: 'warning' },
  before_window: { label: 'Attendance not started', tone: 'info' },
  between_sessions: { label: 'Between sessions', tone: 'warning' },
  day_closed: { label: 'Attendance closed', tone: 'warning' },
  no_session: { label: 'No attendance today', tone: 'warning' },
  attendance_not_conducted: { label: 'Attendance not conducted', tone: 'warning' },
  failed: { label: 'Face not recognized', tone: 'danger' },
};

const attendanceStageByResult = {
  marked: 'marked',
  already_marked: 'duplicate',
  before_window: 'before_window',
  between_sessions: 'between_sessions',
  day_closed: 'day_closed',
  no_session: 'no_session',
  attendance_not_conducted: 'attendance_not_conducted',
};

const attendanceNoticeToneByResult = {
  marked: 'success',
  already_marked: 'warning',
  before_window: 'info',
  between_sessions: 'warning',
  day_closed: 'warning',
  no_session: 'warning',
  attendance_not_conducted: 'warning',
};

const attendanceNoticeTitleByResult = {
  marked: 'Attendance marked',
  already_marked: 'Attendance already marked',
  before_window: 'Attendance not started',
  between_sessions: 'Attendance paused',
  day_closed: 'Attendance closed',
  no_session: 'No attendance today',
  attendance_not_conducted: 'Attendance not conducted',
};

export function ScannerPage({ token, notify }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);

  const [stage, setStage] = useState('idle');
  const [message, setMessage] = useState('Allow camera access to begin attendance scanning.');
  const [error, setError] = useState('');
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState(null);

  const cameraActive = Boolean(streamRef.current);
  const showLivePreview = cameraActive && !error;
  const canScan = cameraActive && !processing;

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
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

  const startCamera = useCallback(async () => {
    setError('');
    setMessage('Starting camera feed...');
    setStage('idle');

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser does not support camera capture.');
      return;
    }

    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      stream.getVideoTracks().forEach((track) => {
        track.enabled = true;
      });
      streamRef.current = stream;
      setStage('ready');
      bindVideoStream();
      setMessage('Camera ready. Position the face inside the scanner frame.');
    } catch {
      setError('Camera permission was blocked or no webcam is available.');
    }
  }, [bindVideoStream, stopCamera]);

  useEffect(() => {
    startCamera();
    return () => stopCamera();
  }, [startCamera, stopCamera]);

  useEffect(() => {
    if (stage === 'ready' || stage === 'analyzing') {
      bindVideoStream();
    }
  }, [bindVideoStream, stage]);

  function captureFrame() {
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
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.9);
  }

  async function handleScan() {
    setProcessing(true);
    setError('');
    setResult(null);
    setStage('analyzing');
    setMessage('Checking attendance window...');

    try {
      const windowStatus = await attendanceApi.windowStatus(token);
      if (!windowStatus.is_open) {
        const blockedStage = attendanceStageByResult[windowStatus.result_code] || 'failed';
        const blockedMessage = windowStatus.message || 'Attendance is not open right now.';
        setStage(blockedStage);
        setMessage(blockedMessage);
        notify(
          attendanceNoticeToneByResult[windowStatus.result_code] || 'info',
          attendanceNoticeTitleByResult[windowStatus.result_code] || 'Attendance update',
          blockedMessage
        );
        return;
      }

      const imageBase64 = captureFrame();
      if (!imageBase64) {
        setError('The camera feed is not ready yet. Please try again.');
        setStage('ready');
        return;
      }

      setMessage('Image captured. Sending it to the recognition engine...');
      const recognized = await attendanceApi.recognize(token, imageBase64);
      setStage('detected');
      setMessage('Face detected. Matching with enrolled face records...');

      if (recognized.status !== 'success' || !recognized.user) {
        setStage('failed');
        setMessage(recognized.message || 'Face not recognized.');
        notify('warning', 'Recognition failed', recognized.message || 'Face not recognized.');
        return;
      }

      setStage('recognized');
      setMessage(`Recognized ${recognized.user.name}. Marking attendance now...`);

      const attendance = await attendanceApi.mark(token, recognized.user.id);
      const resultCode = attendance.result_code || (attendance.already_marked ? 'already_marked' : 'marked');
      const finalStage = attendanceStageByResult[resultCode] || 'failed';
      const nextMessage = attendance.message
        ? `${attendance.user.name} - ${attendance.message}`
        : 'Attendance update received.';
      setStage(finalStage);
      setMessage(nextMessage);
      setResult(
        attendance.attendance
          ? {
              ...attendance,
              confidence: recognized.confidence,
            }
          : null
      );
      notify(
        attendanceNoticeToneByResult[resultCode] || 'info',
        attendanceNoticeTitleByResult[resultCode] || 'Attendance update',
        nextMessage
      );
    } catch (requestError) {
      const nextMessage = getApiErrorMessage(requestError, 'Unable to process attendance scan.');
      setError(nextMessage);
      setStage('failed');
    } finally {
      setProcessing(false);
    }
  }

  const stageInfo = stageMap[stage] || stageMap.idle;

  return (
    <div className="page-stack">
      <PageHeader title="AI Attendance Scanner" subtitle="Live camera recognition for enrolled students and staff with clear detection, match, and attendance feedback states." />

      {error ? <Notice tone="danger" title="Scanner Error">{error}</Notice> : null}

      <div className="dashboard-grid dashboard-grid-two">
        <Panel title="Live Scanner" subtitle="Use the kiosk-ready flow to recognize faces and mark attendance">
          <div className="scanner-toolbar">
            <StatusBadge status={stageInfo.tone === 'success' ? 'present' : stageInfo.tone === 'danger' ? 'absent' : 'late'} />
            <span>{stageInfo.label}</span>
            <button type="button" className="btn-secondary" onClick={startCamera} disabled={processing}>
              <RefreshCw size={16} />
              Restart Camera
            </button>
          </div>

          <div className="scanner-shell">
            {showLivePreview ? (
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
                {processing ? <LoaderCircle className="spin" size={44} /> : <Camera size={44} />}
                <p>{message}</p>
              </div>
            )}
            <div className="scanner-overlay" />
          </div>

          <canvas ref={canvasRef} className="hidden-canvas" />
          <p className="scanner-copy">{message}</p>

          <button type="button" className="btn-primary" onClick={handleScan} disabled={!canScan}>
            {processing ? 'Scanning...' : 'Scan & Mark Attendance'}
          </button>
        </Panel>

        <Panel title="Recognition Outcome" subtitle="Real-time status after each scan attempt">
          {result ? (
            <div className="profile-list">
              <div><span>Name</span><strong>{result.user.name}</strong></div>
              <div><span>Identifier</span><strong>{result.user.identifier}</strong></div>
              <div><span>Department</span><strong>{result.user.department || 'Not assigned'}</strong></div>
              <div><span>Session</span><strong>{result.attendance.session}</strong></div>
              <div><span>Status</span><strong><StatusBadge status={result.attendance.status} /></strong></div>
              <div><span>Confidence</span><strong>{formatPercent((result.confidence || 0) * 100)}</strong></div>
            </div>
          ) : (
            <Notice tone="info" title="Awaiting scan">
              Face detection, recognition, and attendance confirmation details will appear here after each scan.
            </Notice>
          )}
        </Panel>
      </div>
    </div>
  );
}
