const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'YOUR_API_KEY_HERE';

const uploadDir = path.join(__dirname, 'uploads');
const casesDir = path.join(__dirname, 'cases');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(casesDir)) fs.mkdirSync(casesDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('이미지 파일만 업로드 가능합니다.'));
  }
});

app.use(cors());
app.use(express.json({ limit: '30mb' }));
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadDir));

// 이미지 업로드
app.post('/api/upload', upload.array('images', 20), (req, res) => {
  const files = req.files.map(f => ({ filename: f.filename, url: `/uploads/${f.filename}` }));
  res.json({ success: true, files });
});

// Claude API 분석
app.post('/api/analyze', async (req, res) => {
  const { caseTitle, productName, listingContent, buyerInquiries, sellerInquiries, chatHistory, listingImages, buyerImages, sellerImages } = req.body;

  async function loadImages(imgs, label) {
    const result = [];
    if (!imgs || !imgs.length) return result;
    for (const img of imgs) {
      try {
        const imgPath = path.join(uploadDir, path.basename(img.url));
        if (fs.existsSync(imgPath)) {
          const base64 = fs.readFileSync(imgPath).toString('base64');
          const ext = path.extname(imgPath).toLowerCase().replace('.', '');
          const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
          result.push({ type: 'text', text: `[${label}${img.desc ? ' - ' + img.desc : ''}]` });
          result.push({ type: 'image', source: { type: 'base64', media_type: mimeMap[ext] || 'image/jpeg', data: base64 } });
        }
      } catch (e) { console.error('이미지 로드 실패:', e.message); }
    }
    return result;
  }

  const listingImgContents = await loadImages(listingImages, '판매 당시 사진');
  const buyerImgContents = await loadImages(buyerImages, '구매자 증빙 사진');
  const sellerImgContents = await loadImages(sellerImages, '판매자 증빙 사진');

  const buyerText = (buyerInquiries || []).map((inq, i) =>
    `[구매자 ${i + 1}차 문의]${inq.date ? ' (' + inq.date + ')' : ''}\n유형: ${inq.type}${inq.typeDetail ? ' - ' + inq.typeDetail : ''}\n내용: ${inq.content}`
  ).join('\n\n') || '(없음)';

  const sellerText = (sellerInquiries || []).map((inq, i) =>
    `[판매자 ${i + 1}차 문의]${inq.date ? ' (' + inq.date + ')' : ''}\n유형: ${inq.type}${inq.typeDetail ? ' - ' + inq.typeDetail : ''}\n내용: ${inq.content}`
  ).join('\n\n') || '(없음)';

  const systemPrompt = `당신은 중고나라 CX팀의 분쟁조정 전문가입니다.
구매자/판매자 문의(차수별), 채팅 내역, 첨부 이미지를 종합 분석하여 공정하고 중립적으로 분쟁을 조정합니다.

[응답 원칙]
- 모든 회신은 권유형으로 작성 (예: ~하시는 것을 권장드립니다, ~하시길 권유드립니다)
- 확답 또는 단정적 표현 절대 금지
- 중고나라는 플랫폼으로서 거래 당사자가 아님을 명확히 함
- 법적 책임 소재를 단정하지 않음
- 양측 모두에게 공정한 시각 유지
- 문의 유형과 차수를 반드시 분석에 반영
- 한국어로 응답

[출력 형식 - 반드시 아래 JSON 형식으로만 응답]
{
  "summary": "분쟁 핵심 요약 (3~5줄, 문의 유형 및 차수 포함)",
  "analysis": "상황 분석 및 쟁점 정리 (각 문의 차수별 내용 반영, 이미지 분석 포함)",
  "buyerReply": "구매자에게 보낼 회신 초안 (권유형, 정중한 톤)",
  "sellerReply": "판매자에게 보낼 회신 초안 (권유형, 정중한 톤)",
  "recommendation": "처리 방향 권고 (권유형, 2~3가지 옵션 제시)"
}`;

  const userContent = [
    ...listingImgContents,
    ...buyerImgContents,
    ...sellerImgContents,
    {
      type: 'text',
      text: `[케이스 제목] ${caseTitle || '(없음)'}
[상품명] ${productName || '(없음)'}
[판매글 내용]
${listingContent || '(없음)'}

[구매자 문의]
${buyerText}

[판매자 문의]
${sellerText}

[채팅 내역]
${chatHistory || '(없음)'}`
    }
  ];

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 4000, system: systemPrompt, messages: [{ role: 'user', content: userContent }] })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || 'Claude API 오류');
    }

    const data = await response.json();
    const rawText = data.content[0].text;
    let result;
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      result = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
    } catch {
      result = { summary: '분석 완료', analysis: rawText, buyerReply: '', sellerReply: '', recommendation: '' };
    }
    res.json({ success: true, result });
  } catch (e) {
    console.error('분석 오류:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 케이스 저장
app.post('/api/cases', (req, res) => {
  const caseData = { id: uuidv4(), createdAt: new Date().toISOString(), ...req.body };
  fs.writeFileSync(path.join(casesDir, `${caseData.id}.json`), JSON.stringify(caseData, null, 2), 'utf8');
  res.json({ success: true, id: caseData.id });
});

// 케이스 목록
app.get('/api/cases', (req, res) => {
  try {
    const files = fs.readdirSync(casesDir).filter(f => f.endsWith('.json'));
    const cases = files.map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(casesDir, f), 'utf8'));
      return { id: data.id, caseTitle: data.caseTitle || '제목 없음', productName: data.productName || '', createdAt: data.createdAt, summary: data.result?.summary || '' };
    }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, cases });
  } catch (e) { res.json({ success: true, cases: [] }); }
});

// 케이스 상세
app.get('/api/cases/:id', (req, res) => {
  const filePath = path.join(casesDir, `${req.params.id}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: '케이스를 찾을 수 없습니다.' });
  res.json({ success: true, case: JSON.parse(fs.readFileSync(filePath, 'utf8')) });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ 중고나라 분쟁조정 AI 서버 실행 중`);
  console.log(`📍 접속 주소: http://localhost:${PORT}`);
  console.log(`🌐 팀원 접속: http://[이 PC의 IP주소]:${PORT}\n`);
});
