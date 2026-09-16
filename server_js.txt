const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');

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
const upload = multer({ storage, limits: { fileSize: 30 * 1024 * 1024 } }); // 30MB까지 받고 서버에서 압축

app.use(cors());
app.use(express.json({ limit: '30mb' }));
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadDir));

// 이미지 압축 함수 (4MB 이하로)
async function compressImage(filePath) {
  const MAX_SIZE = 4 * 1024 * 1024; // 4MB
  const stat = fs.statSync(filePath);
  if (stat.size <= MAX_SIZE) return; // 이미 작으면 패스

  const ext = path.extname(filePath).toLowerCase();
  const tmpPath = filePath + '.tmp';

  try {
    let quality = 80;
    let compressed;

    // 먼저 리사이즈 (최대 1920px)
    if (ext === '.png') {
      compressed = await sharp(filePath)
        .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
    } else {
      compressed = await sharp(filePath)
        .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
    }

    // 여전히 크면 quality 낮춤
    while (compressed.length > MAX_SIZE && quality > 20) {
      quality -= 10;
      compressed = await sharp(filePath)
        .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
    }

    // 그래도 크면 해상도도 낮춤
    if (compressed.length > MAX_SIZE) {
      compressed = await sharp(filePath)
        .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 60 })
        .toBuffer();
    }

    // 새 파일명 (jpg로 변환)
    const newPath = filePath.replace(/\.[^.]+$/, '.jpg');
    fs.writeFileSync(newPath, compressed);

    // 원본이 다른 확장자면 삭제
    if (newPath !== filePath) {
      fs.unlinkSync(filePath);
    }

    console.log(`이미지 압축: ${stat.size} -> ${compressed.length} bytes`);
  } catch (e) {
    console.error('압축 실패:', e.message);
  }
}

// ────────────────────────────────────────────────────────────
// 개인 간(C2C) 거래 분쟁해결기준 (한국소비자원·공정위·과기부 자율협약, 2025.9.4. 최종본)
// 별표2 품목별 해결기준 요약 - AI 분석의 공식 근거 자료로 사용
// ────────────────────────────────────────────────────────────
const ITEM_STANDARDS = {
  '전자제품(디지털기기)': {
    major: { h24: '구입가 및 운송료 환급 또는 수리비 배상', d7: '구입가 50% 이내 환급 또는 수리비 70% 중 적은 금액 이내 배상', d14: '구입가 30% 또는 수리비 50% 중 적은 금액 이내 배상', after: '분쟁발생 경과·하자 정도 등 종합 판단' },
    minor: { h24: '수리비 배상', d7: '구입가 20% 또는 수리비 30% 중 적은 금액 이내 배상', d14: '구입가 10% 또는 수리비 20% 중 적은 금액 이내 배상', after: '분쟁발생 경과·하자 정도 등 종합 판단' },
  },
  '대형가전': {
    major: { h24: '구입가 및 운송료 환급 또는 수리비 배상', d7: '구입가 50% 이내 환급 또는 수리비 70% 중 적은 금액 이내 배상', d14: '구입가 30% 또는 수리비 50% 중 적은 금액 이내 배상', after: '종합 판단' },
    minor: { h24: '수리비 배상', d7: '구입가 20% 또는 수리비 30% 중 적은 금액 이내 배상', d14: '구입가 10% 또는 수리비 20% 중 적은 금액 이내 배상', after: '종합 판단' },
  },
  '의복류': {
    major: { h24: '구입가 및 운송료 환급 또는 수선비 배상', d7: '구입가 50% 이내 환급 또는 수선비 70% 중 적은 금액 이내 배상', d14: '구입가 30% 또는 수선비 50% 중 적은 금액 이내 배상', after: '종합 판단' },
    minor: { h24: '구입가 30% 이내 또는 수선비 배상', d7: '구입가 10% 또는 수선비 30% 중 적은 금액 이내 배상', d14: '구입가 5% 또는 수리비 10% 중 적은 금액 이내 배상', after: '종합 판단' },
  },
  '잡화': {
    major: { h24: '구입가 및 운송료 환급 또는 수선비 배상', d7: '구입가 50% 이내 환급 또는 수선비 70% 중 적은 금액 이내 배상', d14: '구입가 30% 또는 수선비 50% 중 적은 금액 이내 배상', after: '종합 판단' },
    minor: { h24: '구입가 30% 이내 또는 수선비 배상', d7: '구입가 10% 또는 수선비 30% 중 적은 금액 이내 배상', d14: '구입가 5% 또는 수리비 10% 중 적은 금액 이내 배상', after: '종합 판단' },
  },
  '공산품1(작동)': {
    major: { h24: '구입가 및 운송료 환급 또는 수리비 배상', d7: '구입가 50% 이내 환급 또는 수리비 70% 중 적은 금액 이내 배상', d14: '구입가 30% 또는 수리비 50% 중 적은 금액 이내 배상', after: '종합 판단' },
    minor: { h24: '수리비 배상', d7: '구입가 20% 또는 수리비 30% 중 적은 금액 이내 배상', d14: '구입가 10% 또는 수리비 20% 중 적은 금액 이내 배상', after: '종합 판단' },
  },
  '공산품2(미작동)': {
    major: { h24: '구입가 및 운송료 환급', d7: '구입가 20% 또는 수리비 30% 이내 배상', d14: '구입가 10% 또는 수리비 20% 중 적은 금액 이내 배상', after: '종합 판단' },
    minor: { h24: '구입가 30% 또는 수리비 50% 중 적은 금액 이내 배상', d7: '구입가 10% 또는 수리비 20% 중 적은 금액 이내 배상', d14: '구입가 5% 또는 수리비 10% 중 적은 금액 이내 배상', after: '종합 판단' },
  },
  '식품/식료품/식물': {
    major: { h24: '구입가 및 운송료 환급', d7: '구입가 20% 이내 환급', d14: '구입가 10% 이내 환급', after: '종합 판단' },
    minor: { h24: '구입가 30% 이내 환급', d7: '구입가 10% 이내 환급', d14: '구입가 5% 이내 환급', after: '종합 판단' },
  },
  '미용/의약외품/화학제품': {
    major: { h24: '구입가 및 운송료 환급 또는 수리비 배상', d7: '구입가 20% 또는 수리비 30% 이내 배상', d14: '구입가 10% 또는 수리비 20% 중 적은 금액 이내 배상', after: '종합 판단' },
    minor: { h24: '구입가 30% 또는 수리비 50% 중 적은 금액 이내 배상', d7: '구입가 10% 또는 수리비 20% 중 적은 금액 이내 배상', d14: '구입가 5% 또는 수리비 10% 중 적은 금액 이내 배상', after: '종합 판단' },
  },
  '문화용품 등': {
    major: { h24: '구입가 및 운송료 환급 또는 수리비 배상', d7: '구입가 20% 또는 수리비 30% 이내 환급', d14: '구입가 10% 또는 수리비 20% 이내 배상', after: '종합 판단' },
    minor: { h24: '구입가 30% 또는 수리비 50% 중 적은 금액 이내 배상', d7: '구입가 10% 또는 수리비 20% 중 적은 금액 이내 배상', d14: '구입가 5% 또는 수리비 10% 중 적은 금액 이내 배상', after: '종합 판단' },
  },
};

const SHIPPING_DAMAGE_RULE = '판매자가 물건을 인도하는 과정에서 운송업자 등 제3자의 귀책사유 또는 천재지변 등 불가항력으로 멸실·훼손된 경우: 분실 시 구입가 환급 / 훼손 시 수리(수선) 가능하면 수리비 배상, 불가능하면 구입가 환급 (전 품목 공통)';

const ARTICLE_SUMMARY = [
  '제6조(판매자 사전 고지사항): 판매자는 기본정보·상태(하자)·가격·안전정보를 게시글에 정확히 기재해야 함',
  '제7조(구매자 사전 숙지사항): 구매자는 게시글을 성실히 확인하고 대금을 지체없이 지급해야 함',
  '제8조(플랫폼 운영사업자의 역할): 플랫폼은 자율 분쟁조정으로 우선 해결, 미합의 시 조정위원회 안내',
  '제9조(필수 고지와 판매자 면책): 판매자가 고지한 사항과 동일·유사한 하자는 판매자 면책이 원칙',
  '제10조(판매자 고지 및 계약해제): 환불불가 고지 시 원칙적 해제 불가하나, 고지된 하자보다 실제가 심각하거나 허위고지 시 구매자는 해제·손해배상 가능',
  '제11조(직거래 시의 하자): 거래 당시 확인된 하자는 해제 불가, 고지되지 않은 하자는 해제 가능',
  '제12조(택배거래 시의 하자): 판매자가 하자를 고지했으면 그 외 하자는 구매자가 입증, 배송중 파손은 택배사 책임',
  '제13조(해제 후 원상회복): 계약 해제 시 원상회복 의무, 하자로 인한 해제의 경우 배송비는 판매자 부담',
  '제14조(특수한 유형의 분쟁): 부속품 하자·연락두절·사기/분실/형사사건 관련 물건은 별도 기준 적용(합의기반 분쟁조정 대상 아님)',
  '제15조(하자의 확대 및 2차적 손실): 구매자 과실이 하자 확대에 영향을 미쳤으면 배상 범위 조정',
  '제16조(품목별 하자): 품목별 해결기준은 참고사항이며, 하자 정도·인식차이·사용정도 등을 종합 고려',
].join('\n');

function buildStandardReferenceText() {
  const lines = ['[개인 간 거래 분쟁해결기준 - 품목별 해결기준 요약 (한국소비자원·공정위·과기부 자율협약, 2025.9.4. 최종본 발췌)]'];
  for (const [item, rule] of Object.entries(ITEM_STANDARDS)) {
    lines.push(`\n■ ${item}`);
    lines.push(`- 중대한 하자: 24시간 이내 ${rule.major.h24} / 7일 이내 ${rule.major.d7} / 14일 이내 ${rule.major.d14} / 14일 이후 ${rule.major.after}`);
    lines.push(`- 경미한 하자: 24시간 이내 ${rule.minor.h24} / 7일 이내 ${rule.minor.d7} / 14일 이내 ${rule.minor.d14} / 14일 이후 ${rule.minor.after}`);
  }
  lines.push(`\n■ 배송중 멸실·훼손(전 품목 공통)\n- ${SHIPPING_DAMAGE_RULE}`);
  lines.push(`\n[별표1 일반 조항 요약 (인용 시 조번호를 명시)]\n${ARTICLE_SUMMARY}`);
  return lines.join('\n');
}

const STANDARD_REFERENCE = buildStandardReferenceText();
const ITEM_CATEGORY_LIST = Object.keys(ITEM_STANDARDS);

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
app.post('/api/upload', upload.array('images', 20), async (req, res) => {
  try {
    const files = [];
    for (const f of req.files) {
      await compressImage(f.path);
      // 압축 후 파일명 확인 (jpg로 바뀔 수 있음)
      const baseName = path.basename(f.filename, path.extname(f.filename));
      const jpgPath = path.join(uploadDir, baseName + '.jpg');
      const finalFilename = fs.existsSync(jpgPath) ? baseName + '.jpg' : f.filename;
      files.push({ filename: finalFilename, url: `/uploads/${finalFilename}` });
    }
    res.json({ success: true, files });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Claude 분석
app.post('/api/analyze', async (req, res) => {
  const { caseTitle, productName, listingContent, buyerInquiries, sellerInquiries, chatHistory, listingImages, buyerImages, sellerImages, followUpContext } = req.body;

  async function loadImages(imgs, label) {
    const result = [];
    if (!imgs || !imgs.length) return result;
    for (const img of imgs) {
      try {
        let imgPath = path.join(uploadDir, path.basename(img.url));
        // jpg 버전 확인
        const baseName = path.basename(imgPath, path.extname(imgPath));
        const jpgPath = path.join(uploadDir, baseName + '.jpg');
        if (!fs.existsSync(imgPath) && fs.existsSync(jpgPath)) imgPath = jpgPath;

        if (fs.existsSync(imgPath)) {
          let imgBuffer = fs.readFileSync(imgPath);

          // 혹시 아직 크면 추가 압축
          if (imgBuffer.length > 4 * 1024 * 1024) {
            imgBuffer = await sharp(imgPath).resize(1280, 1280, { fit: 'inside' }).jpeg({ quality: 60 }).toBuffer();
          }
imgBuffer = await sharp(imgPath).jpeg({ quality: 85 }).toBuffer();
          const base64 = imgBuffer.toString('base64');
          result.push({ type: 'text', text: `[${label}${img.desc ? ' - ' + img.desc : ''}]` });
          result.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } });
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

[반드시 근거로 삼아야 할 공식 기준]
아래는 한국소비자원·공정위·과기부가 마련한 「개인 간 거래 분쟁해결기준」 발췌입니다. 물건의 품목·하자 정도(중대/경미)·물건 수령 후 경과기간을 먼저 판단한 뒤, 이 기준표에서 해당 항목을 찾아 처리 방향과 권고 배상·환급 비율의 1차 근거로 삼으세요. 기준표와 다르게 권고할 경우 그 사유(예: 구매자 과실 개입, 판매자 사전고지 존재 등)를 analysis에 명시하세요.
${STANDARD_REFERENCE}

[응답 원칙]
- 모든 회신은 권유형으로 작성 (예: ~하시는 것을 권장드립니다)
- 확답 또는 단정적 표현 절대 금지
- 중고나라는 플랫폼으로서 거래 당사자가 아님을 명확히 함
- 양측 모두에게 공정한 시각 유지
- 품목표 적용이 애매하거나(사기/분실/연락두절 등) 기준이 적용되지 않는 사안이면 appliedItemCategory/appliedArticle을 "해당없음"으로 표기
- 한국어로 응답

[출력 형식 - 반드시 아래 JSON 형식으로만 응답]
{
  "summary": "분쟁 핵심 요약 (3~5줄)",
  "analysis": "상황 분석 및 쟁점 정리",
  "appliedItemCategory": "적용된 품목 대분류 (${ITEM_CATEGORY_LIST.join(' / ')} 중 하나, 해당없음 가능)",
  "appliedDefectLevel": "중대한 하자 / 경미한 하자 / 해당없음 중 하나",
  "appliedPeriod": "24시간 이내 / 7일 이내 / 14일 이내 / 14일 이후 / 해당없음 중 하나",
  "appliedArticle": "근거가 된 별표1 조항 (예: 제12조(택배거래 시의 하자)). 복수면 쉼표로 구분, 없으면 해당없음",
  "suggestedResolution": "위 기준표에 따른 구체적 권고안 (환급/배상 비율을 숫자로 명시)",
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
    catch {
      result = {
        summary: '분석 완료', analysis: rawText,
        appliedItemCategory: '', appliedDefectLevel: '', appliedPeriod: '', appliedArticle: '', suggestedResolution: '',
        buyerReply: '', sellerReply: '', recommendation: '',
      };
    }
    res.json({ success: true, result });
  } catch (e) {
    console.error('분석 오류:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 상담 내역(채팅/티켓) 붙여넣기 → 구매자/판매자 문의를 차수별로 자동 분류
// 다회차 재인입(미수긍 → 추가 문의)이 반복되는 케이스에서 수작업 입력 부담을 줄이기 위한 기능
app.post('/api/parse-inquiries', async (req, res) => {
  const { rawText, side } = req.body;
  if (!rawText || !rawText.trim()) {
    return res.status(400).json({ success: false, error: '붙여넣은 상담 내역이 없습니다.' });
  }

  // side가 지정되면(구매자 칸 / 판매자 칸에 각각 붙여넣은 경우) 화자 구분은 이미 사람이 끝낸 것이므로
  // AI는 "몇 차수로 나눌지"만 판단하면 됨 -> 화자 오분류 위험이 사라짐
  const isSideMode = side === 'buyer' || side === 'seller';
  const sideLabel = side === 'buyer' ? '구매자' : '판매자';

  const parsePrompt = isSideMode ? `당신은 CX 상담 로그 정리 도우미입니다. 아래는 전부 ${sideLabel} 한 사람에게서 나온 문의 내용입니다(다른 화자의 발언은 섞여 있지 않습니다).
이 내용을 시간순으로 읽고, 서로 다른 시점/쟁점의 문의라면 별도 차수로 나누어 정리하세요.

규칙:
- 새로운 쟁점이거나 미수긍 후 재인입이면 별도 차수로 분리하고, 단순 부연 설명이면 직전 차수에 합칩니다.
- 문의가 하나뿐이면 1개짜리 배열로 반환합니다.
- 각 차수의 "type"은 다음 중 가장 가까운 것을 선택하고, 애매하면 "기타"로 둡니다: 환불 요청, 상품 불량, 배송 문제, 반품 거부, 판매글과 실제 상품 상이, 사기 의심, 연락 두절, 기타
- 날짜(date)가 원문에 명시되어 있으면 YYYY-MM-DD로 추출하고, 없으면 빈 문자열로 둡니다.
- content는 원문의 핵심 주장을 존댓말 문장으로 간결히 정리하되 금액·날짜·구체적 요구사항 등 사실관계는 누락하지 않습니다.

반드시 아래 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
{
  "items": [{"date":"", "type":"", "content":""}]
}` : `당신은 CX 상담 로그 정리 도우미입니다. 아래는 구매자·판매자·상담원(CX)의 발언이 시간순으로 뒤섞여 있는 상담 내역(채팅, 게시판 답변, 문의 접수 원문 등)입니다.
이를 화자별로 분리하여 "구매자가 주장·요청한 내용"과 "판매자가 주장·답변한 내용"을 각각 시간순으로 차수를 나누어 정리하세요.

규칙:
- 상담원(CX/운영자/중고나라)의 발언은 별도 차수로 뽑지 말고 필요한 경우 맥락으로만 참고합니다.
- 같은 화자의 발언이라도 새로운 쟁점이거나 미수긍 후 재인입이면 별도 차수로 분리하고, 단순 부연 설명이면 직전 차수에 합칩니다.
- 각 차수의 "type"은 다음 중 가장 가까운 것을 선택하고, 애매하면 "기타"로 둡니다: 환불 요청, 상품 불량, 배송 문제, 반품 거부, 판매글과 실제 상품 상이, 사기 의심, 연락 두절, 기타
- 날짜(date)가 원문에 명시되어 있으면 YYYY-MM-DD로 추출하고, 없으면 빈 문자열로 둡니다.
- content는 원문의 핵심 주장을 존댓말 문장으로 간결히 정리하되 금액·날짜·구체적 요구사항 등 사실관계는 누락하지 않습니다.
- 구매자/판매자 어느 한쪽 발언이 전혀 없으면 해당 배열은 빈 배열로 둡니다.

반드시 아래 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
{
  "buyerInquiries": [{"date":"", "type":"", "content":""}],
  "sellerInquiries": [{"date":"", "type":"", "content":""}]
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-opus-4-5', max_tokens: 3000,
        system: parsePrompt,
        messages: [{ role: 'user', content: rawText }],
      }),
    });
    if (!response.ok) { const err = await response.json(); throw new Error(err.error?.message || 'Claude API 오류'); }
    const data = await response.json();
    const rawOut = data.content[0].text;
    const m = rawOut.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : rawOut);
    if (isSideMode) {
      res.json({ success: true, items: Array.isArray(parsed.items) ? parsed.items : [] });
    } else {
      res.json({
        success: true,
        buyerInquiries: Array.isArray(parsed.buyerInquiries) ? parsed.buyerInquiries : [],
        sellerInquiries: Array.isArray(parsed.sellerInquiries) ? parsed.sellerInquiries : [],
      });
    }
  } catch (e) {
    console.error('문의 자동분류 오류:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 케이스 저장
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
      id: c.id, caseTitle: c.case_title, productName: c.product_name,
      createdAt: c.created_at, summary: c.result?.summary || ''
    }));
    res.json({ success: true, cases });
  } catch (e) { res.json({ success: true, cases: [] }); }
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
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 2차 추가 문의
app.post('/api/cases/:id/followup', async (req, res) => {
  try {
    const existing = await sbFetch(`/cases?id=eq.${req.params.id}`);
    if (!existing || !existing.length) return res.status(404).json({ success: false, error: '케이스를 찾을 수 없습니다.' });
    const followUps = existing[0].follow_ups || [];
    followUps.push({ id: uuidv4(), createdAt: new Date().toISOString(), ...req.body });
    await sbFetch(`/cases?id=eq.${req.params.id}`, { method: 'PATCH', body: JSON.stringify({ follow_ups: followUps }) });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 엑셀 다운로드
app.get('/api/cases/export/excel', async (req, res) => {
  try {
    const data = await sbFetch('/cases?select=*&order=created_at.desc');
    res.json({ success: true, cases: data || [] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ 중고나라 분쟁조정 AI 서버 실행 중`);
  console.log(`📍 접속 주소: http://localhost:${PORT}\n`);
});
