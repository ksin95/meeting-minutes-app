import express from 'express';
import multer from 'multer';
import cors from 'cors';
import nodemailer from 'nodemailer';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Set up temporary uploads directory
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure Multer for audio uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ 
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB max file size
});

// Serve frontend static files in production
const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

/**
 * Helper to convert file to Generative Part object for Gemini
 */
function fileToGenerativePart(filePath, mimeType) {
  return {
    inlineData: {
      data: Buffer.from(fs.readFileSync(filePath)).toString("base64"),
      mimeType
    },
  };
}

/**
 * API: Process Audio - Transcribe, Create Minutes, and optionally Email
 */
app.post('/api/process-audio', upload.single('audio'), async (req, res) => {
  const filePath = req.file?.path;
  
  try {
    const { apiKey, email, customPrompt, smtpConfig, modelName } = req.body;
    
    if (!filePath) {
      return res.status(400).json({ error: '音声ファイルがアップロードされていません。' });
    }
    
    if (!apiKey) {
      return res.status(400).json({ error: 'Gemini APIキーが設定されていません。' });
    }

    // Determine MIME type from file extension or multer
    let mimeType = req.file.mimetype;
    if (mimeType === 'application/octet-stream' || !mimeType) {
      // Fallback detection by extension
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (ext === '.webm') mimeType = 'audio/webm';
      else if (ext === '.mp3') mimeType = 'audio/mp3';
      else if (ext === '.wav') mimeType = 'audio/wav';
      else if (ext === '.m4a') mimeType = 'audio/m4a';
      else if (ext === '.mp4') mimeType = 'audio/mp4';
      else mimeType = 'audio/webm'; // Default to webm (browser default)
    }

    console.log(`Processing audio: ${filePath}, type: ${mimeType}`);

    // Initialize Gemini API
    const genAI = new GoogleGenerativeAI(apiKey);
    
    // Use custom model name if provided, fallback to gemini-1.5-flash
    const selectedModel = modelName || "gemini-1.5-flash";
    console.log(`Using model: ${selectedModel}`);
    const model = genAI.getGenerativeModel({ model: selectedModel });

    const audioPart = fileToGenerativePart(filePath, mimeType);

    const promptText = customPrompt || 
      `あなたは優秀な会議アシスタントです。提供された会議音声ファイルを詳細に文字起こしし、さらにメール配信に適した、見やすく整理された構造的な議事録（Markdown形式）を作成してください。
      
      【メール配信用としての重要指示】
      1. 各セクション（会議タイトル、出席者、決定事項など）の間には、必ず1〜2行の「空行（改行）」を挟んで、視覚的にすっきりと整理してください。
      2. 箇条書きやタスク（ToDo）、議論のまとめなどは、ダラダラと長文にせず、項目ごとに必ず改行を入れて箇条書きで見やすく整理してください。
      3. 会議中の重要な決定事項やタスク（担当者・期限）は、独立したセクションとして特に目立たせて作成してください。
      
      出力は、必ず以下のJSONスキーマに準拠した有効なJSON形式のみで返却してください。マークダウンブロックや余計なテキストをJSONの外に出さないでください。
      
      {
        "transcript": "会議音声の全文文字起こし（可能な限り正確に、話し言葉を日本語テキストに変換してください）",
        "minutes": "見やすく整理されたMarkdown形式の議事録。以下の項目を含めてください：\\n- **会議タイトル**\\n- **開催日時・場所**\\n- **出席者**\\n- **会議の要約**\\n- **決定事項**\\n- **次回までのToDo / タスク（担当者含む）**\\n- **詳細な議論内容のまとめ**"
      }`;

    console.log('Sending request to Gemini...');
    
    const result = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            audioPart,
            { text: promptText }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json"
      }
    });

    const responseText = result.response.text();
    console.log('Received response from Gemini');
    
    let parsedResult;
    try {
      parsedResult = JSON.parse(responseText);
    } catch (parseErr) {
      console.error('Failed to parse Gemini response as JSON. Raw response:', responseText);
      // Fallback if not valid JSON
      parsedResult = {
        transcript: "文字起こしデータの自動パースに失敗しました。生の出力をご確認ください。",
        minutes: responseText
      };
    }

    // Clean up local temp file
    fs.unlinkSync(filePath);

    // If email is configured, send the email
    let emailStatus = 'skipped';
    let emailError = null;

    if (email && email.trim() !== '') {
      try {
        console.log(`Sending email to: ${email}...`);
        
        let parsedSmtp;
        if (smtpConfig) {
          parsedSmtp = typeof smtpConfig === 'string' ? JSON.parse(smtpConfig) : smtpConfig;
        }

        if (parsedSmtp && parsedSmtp.host && parsedSmtp.user && parsedSmtp.pass) {
          // Create transporter using user's custom SMTP configuration
          const transporter = nodemailer.createTransport({
            host: parsedSmtp.host,
            port: parseInt(parsedSmtp.port) || 587,
            secure: parsedSmtp.secure === 'true' || parsedSmtp.secure === true,
            auth: {
              user: parsedSmtp.user,
              pass: parsedSmtp.pass
            }
          });

          const mailOptions = {
            from: `"会議議事録システム" <${parsedSmtp.user}>`,
            to: email,
            subject: `【会議議事録】${new Date().toLocaleDateString('ja-JP')} 議事録`,
            text: `会議の文字起こしと議事録をお送りします。\n\n--- 議事録 ---\n\n${parsedResult.minutes}\n\n--- 文字起こし ---\n\n${parsedResult.transcript}`,
            html: `
              <h2>会議議事録</h2>
              <p>会議の文字起こしと議事録をお送りします。</p>
              <hr />
              <h3>■ 議事録</h3>
              <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; border-left: 4px solid #4f46e5; white-space: pre-wrap;">
                ${parsedResult.minutes.replace(/\n/g, '<br/>')}
              </div>
              <hr />
              <h3>■ 文字起こし（全文）</h3>
              <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; color: #555; white-space: pre-wrap; font-size: 0.9em;">
                ${parsedResult.transcript.replace(/\n/g, '<br/>')}
              </div>
            `
          };
          // Send email in background to avoid blocking HTTP response and causing client-side timeouts
          transporter.sendMail(mailOptions).then(() => {
            console.log('Email sent successfully in background');
          }).catch((mailErr) => {
            console.error('Failed to send email in background:', mailErr.message);
          });
          emailStatus = 'sent_pending';
        } else {
          console.log('SMTP configuration is missing. Skipping email sending.');
          emailStatus = 'missing_config';
        }
      } catch (mailErr) {
        console.error('Failed to initiate email sending:', mailErr);
        emailStatus = 'failed';
        emailError = mailErr.message;
      }
    }

    res.json({
      success: true,
      transcript: parsedResult.transcript,
      minutes: parsedResult.minutes,
      emailStatus,
      emailError
    });

  } catch (error) {
    console.error('Error during processing:', error);
    
    // Diagnostic check for API key validation
    let diagnosticMsg = '';
    try {
      const keyToCheck = req.body?.apiKey;
      if (keyToCheck) {
        const diagUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${keyToCheck}`;
        const diagResp = await fetch(diagUrl);
        const diagData = await diagResp.json();
        
        if (!diagResp.ok) {
          console.error('--- Gemini API Key Diagnostic Result ---');
          console.error('API Error details:', JSON.stringify(diagData));
          if (diagData.error && diagData.error.message) {
            diagnosticMsg = `【APIキー診断結果】: ${diagData.error.message}`;
          }
        } else {
          console.log('--- Gemini API Key is VALID. Available models: ---');
          const models = diagData.models || [];
          models.forEach(m => console.log(` - ${m.name}`));
        }
      } else {
        console.error('Diagnostics skipped: apiKey is missing in req.body');
      }
    } catch (diagErr) {
      console.error('Failed to run diagnostics:', diagErr.message);
    }

    // Cleanup file in case of error
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    const clientErrorMsg = diagnosticMsg 
      ? `${error.message}\n\n${diagnosticMsg}`
      : (error.message || '内部サーバーエラーが発生しました。');
      
    res.status(500).json({ error: clientErrorMsg });
  }
});

// Fallback to React index.html for spa routing
if (fs.existsSync(distPath)) {
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
