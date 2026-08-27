/**
 * ARGUS evidence seed — Scene 6 of the demo script.
 *
 * The main seed (`seed.js`) TRUNCATEs `evidence` and `evidence_anchors` and
 * never refills them, which left the Evidence Locker opening on an empty
 * state. This file fills it — but not with SQL fixtures.
 *
 * Every exhibit here is pushed through the SAME pipeline a real upload takes:
 *
 *     bytes -> sha256(plaintext) -> AES-256-GCM -> disk -> row -> anchor on-chain
 *
 * That distinction is the whole point. A fixture row with a made-up digest and
 * an `encrypted_path` pointing at nothing would render identically in the list
 * and then fail the moment anyone clicked Verify or Download — which is exactly
 * the click a judge makes. Seeding through the real services means the digests
 * are true digests, the ciphertext genuinely exists on disk, `verify` really
 * recomputes and really compares against the chain, and `download` really
 * decrypts. Nothing on this screen is staged.
 *
 * Deterministic: file contents contain no timestamps or random values, so the
 * SHA-256 of each exhibit is stable across re-seeds. Re-running is safe —
 * already-registered digests are adopted rather than double-anchored.
 *
 * Run: npm run seed:evidence   (after npm run seed)
 */

const zlib = require('zlib');
const pool = require('./pool');
const hashService = require('../services/hashService');
const cryptoService = require('../services/cryptoService');

// Must match evidenceController.aadFor — the ciphertext is bound to its row id.
const aadFor = (evidenceId) => `evidence:${evidenceId}`;
const storage = require('../services/storageService');
const chain = require('../services/chainService');

// ---------------------------------------------------------------------------
// File builders — every one emits a genuinely valid file of its declared type
// ---------------------------------------------------------------------------

/** CRC-32, needed for PNG chunks. Table built once. */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * A real 8-bit RGB PNG built from a pixel buffer.
 *
 * Hand-rolled rather than pulled from a library: the seeder must not add a
 * runtime dependency the API itself does not have, and `zlib` (which does the
 * actual compression) is already in Node core.
 */
function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A stylised chat-app screenshot: message bubbles with text rendered as bars.
 *
 * The bars stand in for message text. That is deliberate rather than lazy —
 * this is a synthetic exhibit, and drawing legible fake words into it would
 * invite someone to read them as if they were real intercepted messages. The
 * layout carries what the exhibit is (a thread, who sent what, how long it
 * ran); the words are the part we are not entitled to invent.
 */
function chatScreenshot(width, height, thread) {
  const rgb = Buffer.alloc(width * height * 3);
  const px = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 3;
    rgb[i] = r; rgb[i + 1] = g; rgb[i + 2] = b;
  };
  const rect = (x0, y0, w, h, colour) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px(x, y, colour);
  };

  const BG = [0x0E, 0x14, 0x1B];
  const HEADER = [0x1F, 0x2C, 0x34];
  const IN = [0x26, 0x2D, 0x31];      // received bubble
  const OUT = [0x00, 0x5C, 0x4B];     // sent bubble
  const TEXT = [0xC9, 0xD1, 0xD9];
  const FAINT = [0x8B, 0x98, 0xA5];

  rect(0, 0, width, height, BG);
  rect(0, 0, width, 46, HEADER);
  rect(14, 12, 22, 22, FAINT);          // avatar
  rect(46, 16, 96, 7, TEXT);            // contact name
  rect(46, 28, 58, 5, FAINT);           // "online"

  let y = 58;
  for (const msg of thread) {
    const w = msg.w;
    const x = msg.out ? width - w - 12 : 12;
    const h = 12 + msg.lines * 11;
    rect(x, y, w, h, msg.out ? OUT : IN);
    for (let l = 0; l < msg.lines; l++) {
      // last line is short, as wrapped text actually is
      const lw = l === msg.lines - 1 ? Math.round(w * 0.52) : w - 16;
      rect(x + 8, y + 7 + l * 11, lw, 5, TEXT);
    }
    rect(x + w - 34, y + h - 8, 26, 4, FAINT); // timestamp
    y += h + 8;
    if (y > height - 40) break;
  }

  rect(0, height - 34, width, 34, HEADER);   // composer
  rect(12, height - 25, width - 60, 16, IN);
  return encodePng(width, height, rgb);
}

/**
 * A minimal but structurally valid PDF (1.4), text drawn in Helvetica.
 *
 * Built by hand for the same reason as the PNG: no new dependency. The xref
 * offsets are computed from actual byte positions, so the file opens in a real
 * viewer rather than merely carrying a .pdf extension.
 */
function buildPdf(title, lines) {
  const esc = (s) => String(s).replace(/([\\()])/g, '\\$1');
  const content = [
    'BT', '/F1 15 Tf', '54 782 Td', `(${esc(title)}) Tj`,
    '/F1 9 Tf', '0 -8 Td',
    ...lines.flatMap((l) => ['0 -13 Td', `(${esc(l)}) Tj`]),
    'ET',
  ].join('\n');

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] '
      + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const csv = (header, rows) =>
  Buffer.from([header.join(','), ...rows.map((r) => r.join(','))].join('\r\n') + '\r\n', 'utf8');

const text = (s) => Buffer.from(s.replace(/\n/g, '\r\n'), 'utf8');

// ---------------------------------------------------------------------------
// The exhibit catalogue
// ---------------------------------------------------------------------------
/**
 * Contents reference the ALPHA network the main seed plants — the same
 * complaint refs, accounts and handles the Network Explorer shows. An exhibit
 * naming entities that appear nowhere else would look like evidence and
 * correlate with nothing, which is the opposite of the point.
 *
 * `ageDays` backdates `created_at` so the locker shows a case worked over
 * weeks, not twelve files sealed in the same second.
 */
const EXHIBITS = [
  {
    title: 'WhatsApp thread — handler to victim',
    filename: 'wa-thread-9323592927.png',
    mime: 'image/png',
    type: 'SCREENSHOT',
    complaint: 30,
    by: 3,
    ageDays: 26,
    verifications: 2,
    build: () => chatScreenshot(360, 620, [
      { out: false, w: 210, lines: 2 }, { out: false, w: 176, lines: 1 },
      { out: true, w: 150, lines: 1 }, { out: false, w: 228, lines: 3 },
      { out: false, w: 196, lines: 2 }, { out: true, w: 132, lines: 1 },
      { out: false, w: 240, lines: 2 }, { out: false, w: 168, lines: 1 },
    ]),
  },
  {
    title: 'Telegram channel — @nifty_vip_signals',
    filename: 'tg-nifty-vip-signals.png',
    mime: 'image/png',
    type: 'SCREENSHOT',
    complaint: 25,
    by: 3,
    ageDays: 24,
    verifications: 1,
    build: () => chatScreenshot(360, 560, [
      { out: false, w: 250, lines: 3 }, { out: false, w: 214, lines: 2 },
      { out: false, w: 232, lines: 2 }, { out: false, w: 188, lines: 1 },
      { out: false, w: 246, lines: 3 }, { out: false, w: 160, lines: 1 },
    ]),
  },
  {
    title: 'Bank statement — A/c 40566874830 (mule)',
    filename: 'stmt-40566874830.csv',
    mime: 'text/csv',
    type: 'BANK_STATEMENT',
    complaint: 30,
    by: 5,
    ageDays: 22,
    verifications: 3,
    build: () => csv(
      ['txn_date', 'value_date', 'description', 'ref_no', 'debit_inr', 'credit_inr', 'balance_inr'],
      [
        ['2026-03-02', '2026-03-02', 'IMPS IN/NCRP-2026-004030', 'UTR625355804595', '', '190000.00', '190412.00'],
        ['2026-03-02', '2026-03-02', 'IMPS IN/RETAIL', 'UTR625355991204', '', '148000.00', '338412.00'],
        ['2026-03-03', '2026-03-03', 'NEFT OUT/SETTLEMENT', 'UTR625361004881', '284000.00', '', '54412.00'],
        ['2026-03-04', '2026-03-04', 'IMPS IN/NCRP-2026-004025', 'UTR625374220913', '', '176200.00', '230612.00'],
        ['2026-03-05', '2026-03-05', 'ATM WDL/MUMBAI ANDHERI E', 'ATM8841200', '100000.00', '', '130612.00'],
        ['2026-03-05', '2026-03-05', 'ATM WDL/MUMBAI ANDHERI E', 'ATM8841206', '100000.00', '', '30612.00'],
        ['2026-03-06', '2026-03-06', 'IMPS IN/NCRP-2026-004008', 'UTR625388117740', '', '169400.00', '200012.00'],
        ['2026-03-07', '2026-03-07', 'NEFT OUT/EXCHANGE DESK', 'UTR625390558127', '195000.00', '', '5012.00'],
      ]
    ),
  },
  {
    title: 'Call detail record — 9323592927',
    filename: 'cdr-9323592927.csv',
    mime: 'text/csv',
    type: 'CALL_RECORD',
    complaint: 30,
    by: 5,
    ageDays: 21,
    verifications: 1,
    build: () => csv(
      ['calling_no', 'called_no', 'start_time', 'duration_s', 'call_type', 'first_cgi', 'imei'],
      [
        ['9323592927', '6339622362', '2026-03-01 11:04:22', '412', 'OUT', '404-22-1841-51220', '869210049117324'],
        ['9323592927', '6165187695', '2026-03-01 14:31:08', '196', 'OUT', '404-22-1841-51220', '869210049117324'],
        ['6399053718', '9323592927', '2026-03-02 09:12:47', '638', 'IN', '404-22-1841-51221', '869210049117324'],
        ['9323592927', '6122736860', '2026-03-02 16:55:03', '271', 'OUT', '404-22-1841-51220', '869210049117324'],
        ['9323592927', '9334825546', '2026-03-03 10:19:39', '844', 'OUT', '404-22-1841-51220', '869210049117324'],
        ['6339622362', '9323592927', '2026-03-04 18:02:11', '155', 'IN', '404-22-1841-51223', '869210049117324'],
        ['9323592927', '6981004584', '2026-03-05 12:40:57', '327', 'OUT', '404-22-1841-51220', '869210049117324'],
      ]
    ),
  },
  {
    title: 'Chat log export — handler group',
    filename: 'chatlog-alpha-handlers.txt',
    mime: 'text/plain',
    type: 'CHAT_LOG',
    complaint: 25,
    by: 3,
    ageDays: 19,
    verifications: 0,
    build: () => text(
      'EXPORT: group thread, 6 participants\n'
      + 'SOURCE: device seized under Sec 165 CrPC, exhibit M-4\n'
      + 'RANGE:  2026-02-24 to 2026-03-06\n'
      + 'NOTE:   Message bodies are withheld from this synthetic exhibit. Only\n'
      + '        the traffic pattern is reproduced, which is what the\n'
      + '        correlation engine actually consumes.\n'
      + '---------------------------------------------------------------\n'
      + '2026-02-24 09:14  +91 93235 92927  -> group   [text]\n'
      + '2026-02-24 09:16  +91 63396 22362  -> group   [text]\n'
      + '2026-02-24 09:22  +91 61651 87695  -> group   [image]\n'
      + '2026-02-25 11:03  +91 93235 92927  -> group   [text]\n'
      + '2026-02-25 11:07  +91 63990 53718  -> group   [document]\n'
      + '2026-02-27 20:41  +91 61227 36860  -> group   [text]\n'
      + '2026-03-01 08:55  +91 93235 92927  -> group   [text]\n'
      + '2026-03-02 13:30  +91 93348 25546  -> group   [text]\n'
      + '2026-03-04 17:12  +91 63396 22362  -> group   [image]\n'
      + '2026-03-06 07:48  +91 93235 92927  -> group   [text]\n'
    ),
  },
  {
    title: 'Wallet trace — 0xacba…bdf8',
    filename: 'wallet-trace-0xacba.csv',
    mime: 'text/csv',
    type: 'DOCUMENT',
    complaint: 41,
    by: 4,
    ageDays: 17,
    verifications: 2,
    build: () => csv(
      ['hop', 'tx_hash', 'from_addr', 'to_addr', 'asset', 'amount', 'inr_equiv', 'observed_at'],
      [
        ['1', '0xacba0379a1bf1d27b659bd481320a80a168333a7178391329a72592b9036bdf8',
          '0x7c41ad9e2b5f8c1d0a3e6b94f2d7c85a1e0b3f69', '0x4a2bd18e7f3c05916b8de24a7c1f90b35e6d8271',
          'USDT', '2100.00', '178600', '2026-03-02T18:22:41Z'],
        ['2', '0x5d19bc7e04a2f36189d5c0b7e83a41f2907c6d5b8e3a1f04b92c7d6e5a3f10982',
          '0x4a2bd18e7f3c05916b8de24a7c1f90b35e6d8271', '0x9f3e7a2c8b41d05e6a7f9c30b2d8e41f5a06c9b7',
          'USDT', '2094.00', '178090', '2026-03-02T18:41:09Z'],
        ['3', '0x81c4a06f9d2e753b18a0c47e6d9f2b31570ae8c4d63f01927b5a8e0c4d7f6320',
          '0x9f3e7a2c8b41d05e6a7f9c30b2d8e41f5a06c9b7', '0xd07c4f18a3e69b25c810f7d43a29e6b085c31f4d',
          'USDT', '2081.50', '177027', '2026-03-03T02:07:55Z'],
        ['4', '0x3ba6e12f70c98d541b0a7e36c95d2f18740be9a3c250d81f6379ea4b0c8d2751',
          '0xd07c4f18a3e69b25c810f7d43a29e6b085c31f4d', 'EXCHANGE_DEPOSIT_UNKNOWN',
          'USDT', '2081.50', '177027', '2026-03-03T02:19:12Z'],
      ]
    ),
  },
  {
    title: 'Seizure memo — exhibit M-4 (handset)',
    filename: 'seizure-memo-M4.pdf',
    mime: 'application/pdf',
    type: 'DOCUMENT',
    complaint: 25,
    by: 2,
    ageDays: 14,
    verifications: 1,
    build: () => buildPdf('SEIZURE MEMO - EXHIBIT M-4', [
      'Case reference      : NCRP-2026-004025 (linked: NCRP-2026-004030, -004008)',
      'Network designation : ALPHA',
      'Seizing officer     : Rajesh Menon, Superintendent of Police, CCPS-BLR',
      'Authority           : Section 165 CrPC',
      '',
      'ITEM SEIZED',
      '  1x mobile handset, IMEI 869210049117324',
      '  1x SIM, MSISDN +91 93235 92927',
      '',
      'CONDITION ON SEIZURE',
      '  Powered on, screen unlocked by consent, flight mode enabled at 14:22 hrs',
      '  and maintained until forensic imaging.',
      '',
      'DIGITAL CUSTODY',
      '  A SHA-256 digest of every extracted artefact is registered on the ARGUS',
      '  evidence chain at the moment of intake. The digest, not the file, is what',
      '  is published; the exhibit stays encrypted at rest under AES-256-GCM.',
      '',
      'NOTE',
      '  This is a SYNTHETIC exhibit generated for demonstration. It records no',
      '  real person, device or proceeding.',
    ]),
  },
  {
    title: 'UPI collect requests — 48h window',
    filename: 'upi-collect-48h.csv',
    mime: 'text/csv',
    type: 'BANK_STATEMENT',
    complaint: 8,
    by: 5,
    ageDays: 11,
    verifications: 0,
    build: () => csv(
      ['requested_at', 'payer_vpa', 'payee_vpa', 'amount_inr', 'status', 'rrn', 'device_ip'],
      [
        ['2026-03-05T09:02:11', 'victim1@oksbi', 'quickpay.support@ybl', '48000', 'SUCCESS', '607412008841', '103.87.44.19'],
        ['2026-03-05T09:44:52', 'victim2@okhdfcbank', 'quickpay.support@ybl', '52500', 'SUCCESS', '607412009117', '103.87.44.19'],
        ['2026-03-05T14:18:07', 'victim3@okaxis', 'quickpay.support@ybl', '31000', 'FAILED', '607412011403', '103.87.44.19'],
        ['2026-03-05T14:26:33', 'victim3@okaxis', 'secure.verify@ibl', '31000', 'SUCCESS', '607412011559', '103.87.44.19'],
        ['2026-03-06T10:07:45', 'victim4@oksbi', 'secure.verify@ibl', '67200', 'SUCCESS', '607412020084', '103.87.44.22'],
        ['2026-03-06T16:52:19', 'victim5@okicici', 'secure.verify@ibl', '44800', 'SUCCESS', '607412024417', '103.87.44.22'],
      ]
    ),
  },
  {
    title: 'Victim statement — recorded u/s 161',
    filename: 'statement-004030.pdf',
    mime: 'application/pdf',
    type: 'DOCUMENT',
    complaint: 30,
    by: 3,
    ageDays: 8,
    verifications: 1,
    build: () => buildPdf('STATEMENT RECORDED UNDER SECTION 161 CrPC', [
      'Complaint reference : NCRP-2026-004030',
      'Category            : INVESTMENT_SCAM',
      'Amount reported     : INR 20,40,000',
      'State               : Madhya Pradesh',
      'Recorded by         : Priya Deshmukh, Inspector, CCPS-BLR',
      '',
      'SUMMARY OF SEQUENCE',
      '  1. Contact initiated through a Telegram channel offering "VIP" equity calls.',
      '  2. Complainant moved to a one-to-one WhatsApp thread with a handler.',
      '  3. Four transfers made over eleven days to accounts named by the handler.',
      '  4. Withdrawal request refused; a "release fee" was demanded instead.',
      '  5. Channel access revoked and handler number unreachable.',
      '',
      'ARTEFACTS PRODUCED BY COMPLAINANT',
      '  Screenshots of the channel and the thread; bank debit advices for four',
      '  transfers.',
      '',
      'NOTE',
      '  This is a SYNTHETIC exhibit generated for demonstration. It records no',
      '  real person or proceeding.',
    ]),
  },
  {
    title: 'Mule account KYC bundle',
    filename: 'kyc-bundle-alpha.txt',
    mime: 'text/plain',
    type: 'DOCUMENT',
    complaint: 8,
    by: 4,
    ageDays: 5,
    verifications: 0,
    build: () => text(
      'KYC BUNDLE - ACCOUNTS FLAGGED IN NETWORK ALPHA\n'
      + 'Furnished by bank nodal officer under Sec 91 CrPC\n'
      + '================================================================\n'
      + 'A/c 40566874830   opened 2026-01-18   branch MUMBAI ANDHERI EAST\n'
      + '  address on file matches A/c 22069264273 (same premises)\n'
      + '  mobile on file  +91 63396 22362\n'
      + 'A/c 22069264273   opened 2026-01-18   branch MUMBAI ANDHERI EAST\n'
      + '  address on file matches A/c 40566874830 (same premises)\n'
      + '  mobile on file  +91 63396 22362\n'
      + 'A/c 14177194661   opened 2026-01-24   branch PUNE CAMP\n'
      + '  mobile on file  +91 61651 87695\n'
      + 'A/c 84376224898   opened 2026-02-02   branch NAGPUR SITABULDI\n'
      + '  mobile on file  +91 61651 87695\n'
      + '----------------------------------------------------------------\n'
      + 'OBSERVATION\n'
      + '  Two accounts share a registered address and a registered mobile.\n'
      + '  Two further accounts share a mobile with each other. All four were\n'
      + '  opened inside a nineteen-day window at four different branches.\n'
      + '\n'
      + 'NOTE: SYNTHETIC exhibit. No real customer record is reproduced.\n'
    ),
  },
  {
    title: 'Device extraction report — M-4',
    filename: 'extraction-report-M4.pdf',
    mime: 'application/pdf',
    type: 'DOCUMENT',
    complaint: 41,
    by: 2,
    ageDays: 3,
    verifications: 2,
    build: () => buildPdf('DEVICE EXTRACTION REPORT - EXHIBIT M-4', [
      'Device        : mobile handset, IMEI 869210049117324',
      'Extraction    : full file system, read-only',
      'Examiner      : Rajesh Menon, Superintendent of Police',
      'Linked case   : NCRP-2026-004041',
      '',
      'ARTEFACTS RECOVERED (counts only)',
      '  Messaging threads              14',
      '  Contacts                      211',
      '  Images                        486',
      '  Wallet application present      1  (address 0x4a2b...8271)',
      '  Deleted-but-recoverable msgs   37',
      '',
      'INTEGRITY',
      '  The extraction image was hashed before analysis and the digest',
      '  registered on the ARGUS evidence chain. Any later alteration of the',
      '  image changes its digest and fails verification against the chain.',
      '',
      'NOTE',
      '  This is a SYNTHETIC exhibit generated for demonstration.',
    ]),
  },
  {
    // Deliberately left unanchored — see the note in seal().
    title: 'Cross-border remittance advice',
    filename: 'remittance-advice.csv',
    mime: 'text/csv',
    type: 'BANK_STATEMENT',
    complaint: 41,
    by: 4,
    ageDays: 0,
    verifications: 0,
    skipAnchor: true,
    build: () => csv(
      ['advice_date', 'corridor', 'beneficiary_ref', 'amount_usd', 'inr_equiv', 'purpose_code', 'status'],
      [
        ['2026-03-08', 'IN-AE', 'BEN-77412', '24800.00', '2071640', 'P1099', 'UNDER REVIEW'],
        ['2026-03-08', 'IN-AE', 'BEN-77419', '19200.00', '1603680', 'P1099', 'UNDER REVIEW'],
        ['2026-03-09', 'IN-SG', 'BEN-80233', '31500.00', '2630250', 'P0802', 'HELD'],
      ]
    ),
  },
];

// ---------------------------------------------------------------------------
// Sealing — the real pipeline, one exhibit at a time
// ---------------------------------------------------------------------------

/**
 * Hash, encrypt, store, insert, anchor. Deliberately sequential: anchoring
 * sends a transaction, and firing twelve at once against a single relayer
 * account produces nonce collisions rather than speed.
 */
async function seal(ex) {
  const plaintext = ex.build();
  const sha256 = hashService.sha256(plaintext);

  /**
   * Reserve the row FIRST, then encrypt against its id.
   *
   * The ciphertext is bound to this row by AAD (`evidence:<id>`), so the id has
   * to exist before the sealing can happen — hence the blank-crypto insert and
   * the UPDATE, exactly as evidenceController.upload does it. Seeding by any
   * other route produces exhibits that decrypt under the raw key but fail the
   * AAD check, which presents as "stored bytes unreadable" on every verify.
   *
   * That is not hypothetical: this function used to call `encrypt(plaintext)`
   * with no AAD, and after the evidence-hardening merge every seeded exhibit in
   * the locker failed verification. Any future path that writes evidence must
   * bind the same AAD and record the same key_version, or it will do it again.
   */
  const { rows: reserved } = await pool.query(
    `INSERT INTO evidence (complaint_id, title, filename, mime_type, size_bytes, evidence_type,
                           sha256_hash, encrypted_path, iv, auth_tag, uploaded_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'', '', '', '', $7, now() - ($8 || ' days')::interval)
     RETURNING id, created_at`,
    [ex.complaint, ex.title, ex.filename, ex.mime, plaintext.length, ex.type,
      ex.by, String(ex.ageDays)]
  );
  const row = reserved[0];

  try {
    const { ciphertext, iv, authTag, keyVersion } = cryptoService.encrypt(plaintext, aadFor(row.id));
    const storedName = await storage.write(ciphertext);

    try {
      await pool.query(
        `UPDATE evidence SET sha256_hash=$2, encrypted_path=$3, iv=$4, auth_tag=$5, key_version=$6
          WHERE id=$1`,
        [row.id, sha256, storedName, iv, authTag, keyVersion]
      );
    } catch (err) {
      // Same ordering guarantee the upload controller makes: an orphaned
      // ciphertext is recoverable, a row pointing at a missing file is not.
      await storage.remove(storedName).catch(() => {});
      throw err;
    }
  } catch (err) {
    await pool.query('DELETE FROM evidence WHERE id=$1', [row.id]).catch(() => {});
    throw err;
  }

  await pool.query(
    `INSERT INTO evidence_anchors (evidence_id, network, status) VALUES ($1,$2,'PENDING')`,
    [row.id, chain.status().network || 'localhost']
  );

  /**
   * One exhibit is left PENDING on purpose.
   *
   * A locker where every row is green teaches the wrong thing: it suggests
   * anchoring is instant and never fails. It is neither — it is a network call
   * that can be slow or down, which is exactly why the upload path returns
   * before it completes and the UI polls. Leaving the newest exhibit unanchored
   * makes the PENDING state, the pulsing dot and the Re-anchor button reachable
   * in the demo instead of theoretical.
   */
  let anchor = { status: 'PENDING' };
  if (!ex.skipAnchor) {
    anchor = await chain.anchorEvidence(row.id);
  }

  return { id: row.id, sha256, bytes: plaintext.length, anchor: anchor.status || 'PENDING' };
}

/**
 * Write the custody trail — to the chain as well as to Postgres.
 *
 * The panel this feeds is titled "Chain of custody — every check, permanently",
 * and it renders the ON-CHAIN history, because that is the record the claim
 * rests on. Writing only Postgres rows here produced exactly the contradiction
 * you would expect: the exhibit list counted "2 checks" from the local table
 * while the trail beside it showed one, because the other check had never
 * happened anywhere a verifier could see it.
 *
 * So each backfilled check does what the live verify endpoint does — recompute
 * the digest, compare it against the registry, and log the outcome on-chain —
 * and `is_valid` is the result of that comparison rather than a value typed in.
 * A seeded custody trail that asserts its own integrity is not evidence of
 * anything.
 *
 * The on-chain timestamp is the block's, so it reads as today rather than as
 * the backdated `verified_at`. That is a property of the chain and not
 * something to paper over: you cannot backdate a block, which is most of why
 * anchoring is worth doing.
 */
async function recordVerifications(evidenceId, count, ageDays) {
  if (!count) return 0;

  const { rows } = await pool.query(
    `SELECT sha256_hash FROM evidence WHERE id = $1`, [evidenceId]
  );
  const digest = rows[0].sha256_hash;

  // Checkers rotate across the two investigators and the supervisor: repeat
  // verification by a different officer is the point of a custody trail.
  const CHECKERS = [3, 5, 2, 4];
  let written = 0;

  for (let i = 0; i < count; i++) {
    const onChain = await chain.verifyOnChain(digest);
    const isValid = Boolean(onChain.exists);
    const note = isValid ? 'integrity confirmed' : 'digest not found on chain';

    const logged = isValid
      ? await chain.logVerification(digest, true, note)
      : { ok: false };

    const daysAfter = Math.max(0, ageDays - (i + 1) * 2);
    await pool.query(
      `INSERT INTO verifications (evidence_id, verified_by, computed_hash, chain_hash, is_valid, tx_hash, verified_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() - ($7 || ' days')::interval)`,
      [evidenceId, CHECKERS[i % CHECKERS.length], digest, isValid ? digest : null,
        isValid, logged.txHash || null, String(daysAfter)]
    );
    written++;
  }
  return written;
}

async function run() {
  console.log('ARGUS evidence seed — sealing exhibits through the real pipeline\n');

  const { rows: [existing] } = await pool.query('SELECT count(*)::int AS n FROM evidence');
  if (existing.n > 0) {
    console.log(`  ${existing.n} exhibit(s) already present — clearing first.`);
    // Remove ciphertext before the rows that point at it, or the paths are lost.
    const { rows: old } = await pool.query('SELECT encrypted_path FROM evidence');
    for (const o of old) await storage.remove(o.encrypted_path).catch(() => {});
    await pool.query('TRUNCATE verifications, evidence_anchors, evidence RESTART IDENTITY CASCADE');
  }

  await chain.init();
  const chainState = chain.status();
  console.log(`  chain: ${chainState.ready ? `${chainState.network} (${chainState.chainId})` : `unavailable — ${chainState.reason}`}`);
  if (!chainState.ready) {
    console.log('  exhibits will be sealed and stored, but left PENDING until the chain returns.\n');
  } else {
    console.log('');
  }

  let anchored = 0;
  let checks = 0;
  for (const ex of EXHIBITS) {
    const r = await seal(ex);
    const n = await recordVerifications(r.id, ex.verifications, ex.ageDays);
    checks += n;
    if (r.anchor === 'ANCHORED') anchored++;
    const badge = r.anchor === 'ANCHORED' ? 'anchored' : r.anchor.toLowerCase();
    console.log(
      `  #${String(r.id).padStart(2)}  ${ex.filename.padEnd(30)} `
      + `${String(r.bytes).padStart(7)}B  ${r.sha256.slice(0, 12)}…  ${badge}`
      + (n ? `  ${n} check${n === 1 ? '' : 's'}` : '')
    );
  }

  console.log(`\n  ${EXHIBITS.length} exhibits sealed · ${anchored} anchored · ${checks} custody entries`);
  console.log('  Every digest above is a real SHA-256 of a real file, encrypted on disk.');
  console.log('\n  Verify one:  POST /api/evidence/:id/verify');
}

run()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nEvidence seed failed:', err.message);
    console.error(err.stack);
    pool.end().finally(() => process.exit(1));
  });
