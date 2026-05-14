const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => { const ext = path.extname(file.originalname); cb(null, `${uuidv4()}${ext}`); }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (req, file, cb) => { if (file.mimetype.startsWith('image/')) cb(null, true); else cb(new Error('이미지만 가능')); } });

app.use(cors());
app.use(express.json({ limit: '30mb' }));
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadDir));

// Supabase 요청 헬퍼
async function sbFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || '',
      ...options.headers
    }
  });
  if (!res.ok) { const e = await res.text(); throw new Error(e); }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// 이미지 업로드
app.post('/api/upload', upload.array('images', 20), (req, res) => {
  const files = req.files.map(f => ({ filename: f.filename, url: `/uploads/${f.filename}` }));
  res.json({ success: true, files });
});

// Claude 분석
app.post('/api/analyze', async (req, res) => {
  const { caseTitle, productName, listingContent, buyerInquiries, sellerInquiries, chatHistory, listingImages, buyerImages, sellerImages, followUpContext } = req.body;

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
    `[구매자 ${i+1}차 문의]${inq.date ? ' ('+inq.date+')' : ''}\n유형: ${inq.type}\n내용: ${inq.content}`
  ).join('\n\n') || '(없음)';

  const sellerText = (sellerInquiries || []).map((inq, i) =>
    `[판매자 ${i+1}차 문의]${inq.date ? ' ('+inq.date+')' : ''}\n유형: ${inq.type}\n내용: ${inq.content}`
  ).join('\n\n') || '(없음)';

  const isFollowUp = !!followUpContext;

  const systemPrompt = `당신은 중고나라 CX팀의 분쟁조정 전문가입니다.
구매자/판매자 문의(차수별), 채팅 내역, 첨부 이미지를 종합 분석하여 공정하고 중립적으로 분쟁을 조정합니다.
${isFollowUp ? '이번 분석은 기존 1차 분석 이후 추가 문의에 대한 재분석입니다. 기존 맥락을 반드시 참고하세요.' : ''}

[응답 원칙]
- 모든 회신은 권유형으로 작성 (예: ~하시는 것을 권장드립니다)
- 확답 또는 단정적 표현 절대 금지
- 중고나라는 플랫폼으로서 거래 당사자가 아님을 명확히 함
- 양측 모두에게 공정한 시각 유지
- 한국어로 응답

[출력 형식 - 반드시 아래 JSON 형식으로만 응답]
{
  "summary": "분쟁 핵심 요약 (3~5줄)",
  "analysis": "상황 분석 및 쟁점 정리",
  "buyerReply": "구매자에게 보낼 회신 초안 (권유형)",
  "sellerReply": "판매자에게 보낼 회신 초안 (권유형)",
  "recommendation": "처리 방향 권고 (권유형, 2~3가지 옵션)"
}`;

  const userContent = [
    ...listingImgContents, ...buyerImgContents, ...sellerImgContents,
    {
      type: 'text',
      text: `${isFollowUp ? `[기존 1차 분석 결과]\n${followUpContext}\n\n[추가 문의 내용]\n` : ''}[케이스 제목] ${caseTitle||'(없음)'}
[상품명] ${productName||'(없음)'}
[판매글 내용]\n${listingContent||'(없음)'}

[구매자 문의]\n${buyerText}

[판매자 문의]\n${sellerText}

[채팅 내역]\n${chatHistory||'(없음)'}`
    }
  ];

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 4000, system: systemPrompt, messages: [{ role: 'user', content: userContent }] })
    });
    if (!response.ok) { const err = await response.json(); throw new Error(err.error?.message || 'Claude API 오류'); }
    const data = await response.json();
    const rawText = data.content[0].text;
    let result;
    try { const m = rawText.match(/\{[\s\S]*\}/); result = JSON.parse(m ? m[0] : rawText); }
    catch { result = { summary: '분석 완료', analysis: rawText, buyerReply: '', sellerReply: '', recommendation: '' }; }
    res.json({ success: true, result });
  } catch (e) {
    console.error('분석 오류:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 케이스 저장 (Supabase)
app.post('/api/cases', async (req, res) => {
  try {
    const caseData = {
      case_title: req.body.caseTitle || '제목 없음',
      product_name: req.body.productName || '',
      listing_content: req.body.listingContent || '',
      buyer_inquiries: req.body.buyerInquiries || [],
      seller_inquiries: req.body.sellerInquiries || [],
      chat_history: req.body.chatHistory || '',
      listing_images: req.body.listingImages || [],
      buyer_images: req.body.buyerImages || [],
      seller_images: req.body.sellerImages || [],
      result: req.body.result || {},
      follow_ups: []
    };
    const data = await sbFetch('/cases', { method: 'POST', prefer: 'return=representation', body: JSON.stringify(caseData) });
    res.json({ success: true, id: data[0].id });
  } catch (e) {
    console.error('케이스 저장 오류:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 케이스 목록
app.get('/api/cases', async (req, res) => {
  try {
    const data = await sbFetch('/cases?select=id,case_title,product_name,created_at,result&order=created_at.desc');
    const cases = (data || []).map(c => ({
      id: c.id,
      caseTitle: c.case_title,
      productName: c.product_name,
      createdAt: c.created_at,
      summary: c.result?.summary || ''
    }));
    res.json({ success: true, cases });
  } catch (e) {
    res.json({ success: true, cases: [] });
  }
});

// 케이스 상세
app.get('/api/cases/:id', async (req, res) => {
  try {
    const data = await sbFetch(`/cases?id=eq.${req.params.id}`);
    if (!data || !data.length) return res.status(404).json({ success: false, error: '케이스를 찾을 수 없습니다.' });
    const c = data[0];
    res.json({ success: true, case: {
      id: c.id, caseTitle: c.case_title, productName: c.product_name,
      listingContent: c.listing_content, buyerInquiries: c.buyer_inquiries,
      sellerInquiries: c.seller_inquiries, chatHistory: c.chat_history,
      listingImages: c.listing_images, buyerImages: c.buyer_images,
      sellerImages: c.seller_images, result: c.result, followUps: c.follow_ups || [],
      createdAt: c.created_at
    }});
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 2차 추가 문의 저장
app.post('/api/cases/:id/followup', async (req, res) => {
  try {
    const existing = await sbFetch(`/cases?id=eq.${req.params.id}`);
    if (!existing || !existing.length) return res.status(404).json({ success: false, error: '케이스를 찾을 수 없습니다.' });
    const followUps = existing[0].follow_ups || [];
    const newFollowUp = { id: uuidv4(), createdAt: new Date().toISOString(), ...req.body };
    followUps.push(newFollowUp);
    await sbFetch(`/cases?id=eq.${req.params.id}`, { method: 'PATCH', body: JSON.stringify({ follow_ups: followUps }) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 엑셀 다운로드용 전체 케이스
app.get('/api/cases/export/excel', async (req, res) => {
  try {
    const data = await sbFetch('/cases?select=*&order=created_at.desc');
    res.json({ success: true, cases: data || [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ 중고나라 분쟁조정 AI 서버 실행 중`);
  console.log(`📍 접속 주소: http://localhost:${PORT}\n`);
});
