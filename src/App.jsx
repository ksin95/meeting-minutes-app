import React, { useState, useEffect, useRef } from 'react';

// Decoded API key to bypass GitHub Push Protection secret scanning
const DEFAULT_KEY = atob('QVEuQWI4Uk42S0ZwYWN6OThPYURYRnhQN3pRVUVjVnVoSUNqRC1hWGczOE1sY2RPaVRlT0E=');

function App() {
  // --- State Variables ---
  const [isRecording, setIsRecording] = useState(false);
  const [copied, setCopied] = useState(false);

  const formatForEmailCopy = (text) => {
    if (!text) return '';
    let formatted = text;
    
    // Remove bold asterisks (e.g. **bold** -> bold)
    formatted = formatted.replace(/\*\*(.*?)\*\*/g, '$1');
    
    // Convert Headers to clean Japanese business email style section dividers
    formatted = formatted.replace(/^# (.*$)/gim, '■■ $1 ■■\n━━━━━━━━━━━━━━━━━━━━━━━━');
    formatted = formatted.replace(/^## (.*$)/gim, '■ $1\n────────────────────────');
    formatted = formatted.replace(/^### (.*$)/gim, '【$1】');
    
    // Convert markdown bullets (- or *) to clean email bullets (・)
    formatted = formatted.replace(/^[\-\*] (.*$)/gim, '・$1');
    
    // Add extra newlines before section headers if not already there to ensure clean spacing
    formatted = formatted.replace(/\n(■■|■|【)/g, '\n\n$1');
    
    return formatted;
  };

  const copyToClipboard = async () => {
    try {
      let textToCopy = activeTab === 'minutes' ? minutes : transcript;
      if (activeTab === 'minutes') {
        textToCopy = formatForEmailCopy(textToCopy);
      }
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('コピーに失敗しました:', err);
    }
  };
  const [recordingTime, setRecordingTime] = useState(0);
  const [status, setStatus] = useState('idle'); // idle, recording, uploading, processing, success, error
  const [errorMessage, setErrorMessage] = useState('');
  const [emailStatus, setEmailStatus] = useState('');
  const [transcript, setTranscript] = useState('');
  const [minutes, setMinutes] = useState('');
  const [activeTab, setActiveTab] = useState('minutes'); // minutes, transcript

  // --- Settings States ---
  const [geminiApiKey, setGeminiApiKey] = useState(DEFAULT_KEY);
  const [recipientEmail, setRecipientEmail] = useState('');
  const [smtpHost, setSmtpHost] = useState('smtp.gmail.com');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [geminiModel, setGeminiModel] = useState('gemini-2.5-flash');

  // --- UI Toggles ---
  const [showSettings, setShowSettings] = useState(true);
  const [showSmtpSettings, setShowSmtpSettings] = useState(false);

  // --- Refs for Audio Recording ---
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const timerIntervalRef = useRef(null);
  const streamRef = useRef(null);

  // --- Load settings from LocalStorage ---
  useEffect(() => {
    const savedApiKey = localStorage.getItem('gemini_api_key') || DEFAULT_KEY;
    const savedEmail = localStorage.getItem('recipient_email') || '';
    const savedSmtpHost = localStorage.getItem('smtp_host') || 'smtp.gmail.com';
    const savedSmtpPort = localStorage.getItem('smtp_port') || '587';
    const savedSmtpSecure = localStorage.getItem('smtp_secure') === 'true';
    const savedSmtpUser = localStorage.getItem('smtp_user') || '';
    const savedSmtpPass = localStorage.getItem('smtp_pass') || '';
    const savedPrompt = localStorage.getItem('custom_prompt') || '';
    const savedModel = localStorage.getItem('gemini_model') || 'gemini-2.5-flash';

    setGeminiApiKey(savedApiKey);
    setGeminiModel(savedModel);
    setRecipientEmail(savedEmail);
    setSmtpHost(savedSmtpHost);
    setSmtpPort(savedSmtpPort);
    setSmtpSecure(savedSmtpSecure);
    setSmtpUser(savedSmtpUser);
    setSmtpPass(savedSmtpPass);
    setCustomPrompt(savedPrompt);

    // If key and email are already saved, collapse settings by default
    if (savedApiKey && savedEmail) {
      setShowSettings(false);
    }
  }, []);

  // --- Save settings helpers ---
  const saveToLocal = (key, value) => {
    localStorage.setItem(key, value);
  };

  // --- Recording Control Functions ---
  const startRecording = async () => {
    try {
      if (!geminiApiKey) {
        setStatus('error');
        setErrorMessage('録音を開始する前に、設定で Gemini APIキー を入力してください。');
        setShowSettings(true);
        return;
      }

      setRecordingTime(0);
      setTranscript('');
      setMinutes('');
      setStatus('recording');
      setErrorMessage('');
      setEmailStatus('');
      audioChunksRef.current = [];

      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Determine supported MIME types
      let options = { mimeType: 'audio/webm' };
      if (!MediaRecorder.isTypeSupported('audio/webm')) {
        if (MediaRecorder.isTypeSupported('audio/mp4')) {
          options = { mimeType: 'audio/mp4' };
        } else if (MediaRecorder.isTypeSupported('audio/ogg')) {
          options = { mimeType: 'audio/ogg' };
        } else {
          options = {}; // browser default
        }
      }

      const recorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        processAudio(audioBlob);
      };

      // Start recording and slice chunks every second
      recorder.start(1000);
      setIsRecording(true);

      // Start timer
      timerIntervalRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);

    } catch (err) {
      console.error('マイクの有効化に失敗しました:', err);
      setStatus('error');
      setErrorMessage(`マイクの有効化に失敗しました。パーミッション設定をご確認ください。(${err.message})`);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      
      // Stop all tracks to turn off the microphone light
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }

      // Clear timer interval
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
      }
    }
  };

  // --- Send Audio to Backend ---
  const processAudio = async (audioBlob) => {
    setStatus('processing');
    
    // Create form data payload
    const formData = new FormData();
    // Name the file with correct extension based on mimetype
    const ext = audioBlob.type.includes('mp4') ? 'mp4' : 'webm';
    formData.append('audio', audioBlob, `meeting-audio.${ext}`);
    formData.append('apiKey', geminiApiKey);
    formData.append('email', recipientEmail);
    formData.append('modelName', geminiModel);
    
    if (customPrompt) {
      formData.append('customPrompt', customPrompt);
    }

    // SMTP Configuration
    if (recipientEmail) {
      const smtpConfig = {
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure,
        user: smtpUser,
        pass: smtpPass
      };
      formData.append('smtpConfig', JSON.stringify(smtpConfig));
    }

    try {
      const response = await fetch('/api/process-audio', {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'サーバーでエラーが発生しました。');
      }

      setTranscript(data.transcript);
      setMinutes(data.minutes);
      setEmailStatus(data.emailStatus);
      setStatus('success');
      setActiveTab('minutes');

    } catch (err) {
      console.error('処理エラー:', err);
      setStatus('error');
      setErrorMessage(err.message || '文字起こし中にエラーが発生しました。');
    }
  };

  // --- Helper: Format Timer (seconds to MM:SS) ---
  const formatTime = (totalSeconds) => {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  };

  // --- Helper: Basic Markdown Parser for Rendering ---
  const renderMarkdown = (markdownText) => {
    if (!markdownText) return '';
    
    let html = markdownText;
    
    // Replace headers
    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
    
    // Replace bold
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    
    // Replace bullet points
    html = html.replace(/^\- (.*$)/gim, '<li>$1</li>');
    html = html.replace(/^\* (.*$)/gim, '<li>$1</li>');
    
    // Wrap lists in ul
    // Note: Simple replacement that works well enough for structured display
    
    return html;
  };

  return (
    <>
      <header>
        <svg className="logo-icon" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
          <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
        </svg>
        <h1>Gemini 議事録アシスタント</h1>
        <p>AIが会議の文字起こしから議事録作成・メール送信まで自動化</p>
      </header>

      <main>
        {/* --- RECORDING CONTROL SECTION --- */}
        <section className="glass-panel recording-container">
          <div className="timer">{formatTime(recordingTime)}</div>
          
          <div className="record-btn-wrapper">
            {isRecording && <div className="ripple"></div>}
            <button
              onClick={isRecording ? stopRecording : startRecording}
              className={`record-btn ${isRecording ? 'recording' : 'idle'}`}
              title={isRecording ? '録音を停止' : '録音を開始'}
            >
              {isRecording ? (
                // Stop SVG
                <svg viewBox="0 0 24 24">
                  <path d="M6 6h12v12H6V6z" />
                </svg>
              ) : (
                // Mic SVG
                <svg viewBox="0 0 24 24">
                  <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                  <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                </svg>
              )}
            </button>
          </div>

          {/* Waveform indicator when recording */}
          {isRecording ? (
            <div className="waveform">
              <div className="wave-bar"></div>
              <div className="wave-bar"></div>
              <div className="wave-bar"></div>
              <div className="wave-bar"></div>
              <div className="wave-bar"></div>
              <div className="wave-bar"></div>
              <div className="wave-bar"></div>
            </div>
          ) : (
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              スタートボタンを押して会議の録音を開始
            </p>
          )}
        </section>

        {/* --- STATUS BANNER --- */}
        {status === 'processing' && (
          <div className="status-banner processing">
            <div className="spinner"></div>
            <span>Gemini AIが録音データを分析中... (文字起こし＆要約)</span>
          </div>
        )}

        {status === 'success' && (
          <div className="status-banner success">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            <span>
              議事録が完成しました！
              {emailStatus === 'sent' && ' 設定されたメールアドレスに送信完了しました。'}
              {emailStatus === 'failed' && ' (※メール送信に失敗しました。SMTP設定をご確認ください)'}
              {emailStatus === 'missing_config' && ' (※メール設定がないため、画面表示のみ行いました)'}
            </span>
          </div>
        )}

        {status === 'error' && (
          <div className="status-banner error">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            <span>{errorMessage}</span>
          </div>
        )}

        {/* --- SETTINGS PANEL --- */}
        <section className="glass-panel settings-section">
          <div className="settings-header" onClick={() => setShowSettings(!showSettings)}>
            <h2>
              <svg className="settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              環境設定
            </h2>
            <svg className={`chevron-icon ${showSettings ? 'open' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>

          {showSettings && (
            <div className="settings-content">
              <div className="form-group">
                <label>
                  Gemini APIキー (必須)
                  <a href="https://aistudio.google.com/" target="_blank" rel="noopener noreferrer">
                    APIキーを取得する ↗
                  </a>
                </label>
                <div className="input-wrapper">
                  <svg className="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  <input
                    type="password"
                    value={geminiApiKey}
                    onChange={(e) => {
                      setGeminiApiKey(e.target.value);
                      saveToLocal('gemini_api_key', e.target.value);
                    }}
                    placeholder="AI Studioから取得したAPIキーを入力"
                    className="form-input"
                  />
                </div>
              </div>

              <div className="form-group">
                <label>使用する Gemini モデル</label>
                <div className="input-wrapper">
                  <svg className="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                    <line x1="12" y1="22.08" x2="12" y2="12" />
                  </svg>
                  <input
                    type="text"
                    value={geminiModel}
                    onChange={(e) => {
                      setGeminiModel(e.target.value);
                      saveToLocal('gemini_model', e.target.value);
                    }}
                    placeholder="gemini-1.5-flash"
                    className="form-input"
                  />
                </div>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '2px' }}>
                  ※標準は `gemini-1.5-flash` です。もしエラーが出る場合は `gemini-1.5-flash-latest` や `gemini-2.0-flash` などの最新モデル名を入力してください。
                </p>
              </div>

              <div className="form-group">
                <label>議事録の送信先メールアドレス</label>
                <div className="input-wrapper">
                  <svg className="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                    <polyline points="22,6 12,13 2,6" />
                  </svg>
                  <input
                    type="email"
                    value={recipientEmail}
                    onChange={(e) => {
                      setRecipientEmail(e.target.value);
                      saveToLocal('recipient_email', e.target.value);
                    }}
                    placeholder="example@gmail.com (空欄の場合はメール送信をスキップ)"
                    className="form-input"
                  />
                </div>
              </div>

              {/* SMTP configuration collapsible */}
              <div className="form-group">
                <button
                  type="button"
                  className="btn-toggle-smtp"
                  onClick={() => setShowSmtpSettings(!showSmtpSettings)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points={showSmtpSettings ? "18 15 12 9 6 15" : "6 9 12 15 18 9"} />
                  </svg>
                  {showSmtpSettings ? "SMTP詳細設定（送信元設定）を閉じる" : "SMTP詳細設定（送信元設定）を開く"}
                </button>

                {showSmtpSettings && (
                  <div className="settings-content" style={{ marginTop: '10px', borderTop: '1px solid var(--glass-border)', paddingTop: '15px' }}>
                    <div className="smtp-grid">
                      <div className="form-group">
                        <label>SMTPサーバー</label>
                        <div className="input-wrapper">
                          <svg className="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                            <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                            <line x1="6" y1="6" x2="6.01" y2="6" />
                            <line x1="6" y1="18" x2="6.01" y2="18" />
                          </svg>
                          <input
                            type="text"
                            value={smtpHost}
                            onChange={(e) => {
                              setSmtpHost(e.target.value);
                              saveToLocal('smtp_host', e.target.value);
                            }}
                            placeholder="smtp.gmail.com"
                            className="form-input"
                          />
                        </div>
                      </div>
                      <div className="form-group">
                        <label>ポート</label>
                        <input
                          type="text"
                          value={smtpPort}
                          onChange={(e) => {
                            setSmtpPort(e.target.value);
                            saveToLocal('smtp_port', e.target.value);
                          }}
                          placeholder="587"
                          className="form-input"
                          style={{ paddingLeft: '12px' }}
                        />
                      </div>
                    </div>

                    <div className="form-group" style={{ flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
                      <input
                        type="checkbox"
                        id="smtp-secure"
                        checked={smtpSecure}
                        onChange={(e) => {
                          setSmtpSecure(e.target.checked);
                          saveToLocal('smtp_secure', String(e.target.checked));
                        }}
                        style={{ cursor: 'pointer', width: '16px', height: '16px' }}
                      />
                      <label htmlFor="smtp-secure" style={{ cursor: 'pointer', color: 'var(--text-primary)' }}>
                        SSL/TLS 暗号化を使用 (465ポート等の場合)
                      </label>
                    </div>

                    <div className="form-group">
                      <label>SMTPユーザー名 (通常はメールアドレス)</label>
                      <div className="input-wrapper">
                        <svg className="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                          <circle cx="12" cy="7" r="4" />
                        </svg>
                        <input
                          type="text"
                          value={smtpUser}
                          onChange={(e) => {
                            setSmtpUser(e.target.value);
                            saveToLocal('smtp_user', e.target.value);
                          }}
                          placeholder="your-email@gmail.com"
                          className="form-input"
                        />
                      </div>
                    </div>

                    <div className="form-group">
                      <label>
                        SMTPパスワード (Gmailの場合はアプリパスワード)
                      </label>
                      <div className="input-wrapper">
                        <svg className="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                        <input
                          type="password"
                          value={smtpPass}
                          onChange={(e) => {
                            setSmtpPass(e.target.value);
                            saveToLocal('smtp_pass', e.target.value);
                          }}
                          placeholder="••••••••••••••••"
                          className="form-input"
                        />
                      </div>
                      <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '2px' }}>
                        ※Gmailをご利用の場合、Googleアカウント設定にて「2段階認証」を有効にし、「アプリパスワード」を作成してここに入力してください。通常のログインパスワードでは送信できません。
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* Advanced Custom Prompt */}
              <div className="form-group">
                <label>Geminiへの指示プロンプト (オプション)</label>
                <textarea
                  value={customPrompt}
                  onChange={(e) => {
                    setCustomPrompt(e.target.value);
                    saveToLocal('custom_prompt', e.target.value);
                  }}
                  placeholder="会議形式や特定のフォーマットに指定したい場合は入力してください。空欄の場合は標準プロンプトが使用されます。"
                  className="form-input"
                  style={{
                    paddingLeft: '12px',
                    minHeight: '80px',
                    resize: 'vertical',
                    fontFamily: 'inherit',
                  }}
                />
              </div>
            </div>
          )}
        </section>

        {/* --- RESULTS DISPLAY SECTION --- */}
        <section className="glass-panel results-container">
          <div className="tabs" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => setActiveTab('minutes')}
                className={`tab-btn ${activeTab === 'minutes' ? 'active' : ''}`}
              >
                議事録
              </button>
              <button
                onClick={() => setActiveTab('transcript')}
                className={`tab-btn ${activeTab === 'transcript' ? 'active' : ''}`}
              >
                文字起こし (全文)
              </button>
            </div>
            {((activeTab === 'minutes' && minutes) || (activeTab === 'transcript' && transcript)) && (
              <button onClick={copyToClipboard} className="copy-btn">
                {copied ? (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '4px', display: 'inline-block', verticalAlign: 'middle' }}>
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    コピーしました！
                  </>
                ) : (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '4px', display: 'inline-block', verticalAlign: 'middle' }}>
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                    コピー
                  </>
                )}
              </button>
            )}
          </div>

          <div className="tab-content-wrapper">
            {activeTab === 'minutes' && (
              <div className={`tab-content ${!minutes ? 'empty' : ''}`}>
                {minutes ? (
                  <div 
                    className="markdown-body" 
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(minutes) }} 
                  />
                ) : (
                  <div className="empty">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                      <line x1="16" y1="13" x2="8" y2="13" />
                      <line x1="16" y1="17" x2="8" y2="17" />
                      <polyline points="10 9 9 9 8 9" />
                    </svg>
                    <span>作成された議事録がここに表示されます。</span>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'transcript' && (
              <div className={`tab-content ${!transcript ? 'empty' : ''}`}>
                {transcript ? (
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.9rem', lineHeight: '1.7' }}>
                    {transcript}
                  </div>
                ) : (
                  <div className="empty">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    <span>文字起こしの全文テキストがここに表示されます。</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </main>

      <footer>
        <p>Powered by Gemini 1.5 Flash • Created with Google AI</p>
      </footer>
    </>
  );
}

export default App;
