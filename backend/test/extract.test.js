/**
 * The local regex extraction tier.
 *
 * These tests exist because a false positive here is not a missing feature — it
 * is an INVENTED LINK between two unrelated victims, drawn on a graph, in front
 * of judges. Most of what follows asserts what must NOT be extracted.
 *
 * The cases are shared with intel-service/tests/test_extract.py deliberately.
 * Two implementations of the same patterns can drift, and the failure mode of
 * drift is silent: the Python tier finds an identifier the JS tier misses, so a
 * complaint filed while FastAPI is down links to fewer cases than the same
 * complaint filed a minute later. Identical fixtures on both sides turn that
 * into a failing test instead of a mystery.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { extract } = require('../src/services/localExtract');

const typesOf = (text) => extract(text).entities.map((e) => e.type).sort();
const valueOf = (text, type) =>
  extract(text).entities.find((e) => e.type === type)?.normalized_value;

// A verbatim narrative from the seeded corpus — the exact shape the demo runs.
const REAL_NARRATIVE =
  'I was contacted on WhatsApp from +91 9334825546 regarding a crypto arbitrage '
  + 'opportunity. They asked me to first send ₹42,500 to Axis Bank account 32118638954, '
  + 'and later told me to buy USDT and transfer to wallet address '
  + '0xf3cBd2C5295dcDD0dEbC810f9ABF6eB8f0BEb32a. The dashboard showed my balance growing '
  + 'but withdrawal never worked. Their telegram was @nifty_vip_signals. I also paid '
  + '2,85,000 via UPI imran@okhdfcbank as "gas fee".';

test('extracts every identifier from a real seeded narrative', () => {
  const found = extract(REAL_NARRATIVE);
  assert.deepEqual(
    typesOf(REAL_NARRATIVE),
    ['BANK_ACCOUNT', 'PHONE', 'TELEGRAM', 'UPI', 'WALLET'],
    'this narrative carries exactly these five identifier types'
  );

  assert.equal(valueOf(REAL_NARRATIVE, 'PHONE'), '9334825546');
  assert.equal(valueOf(REAL_NARRATIVE, 'BANK_ACCOUNT'), '32118638954');
  assert.equal(valueOf(REAL_NARRATIVE, 'UPI'), 'imran@okhdfcbank');
  assert.equal(valueOf(REAL_NARRATIVE, 'TELEGRAM'), 'nifty_vip_signals');
  assert.equal(
    valueOf(REAL_NARRATIVE, 'WALLET'),
    '0xf3cbd2c5295dcdd0debc810f9abf6eb8f0beb32a',
    'wallets must lowercase — checksum casing is not identity'
  );
  assert.ok(found.entities.every((e) => e.context_snippet), 'every hit needs a snippet');
});

// ---------------------------------------------------------------------------
// What must NOT be extracted
// ---------------------------------------------------------------------------

test('rupee amounts never become bank accounts', () => {
  // The single most dangerous false positive: a narrative is full of amounts,
  // and treating one as an account invents a suspect account from nothing.
  const amounts = 'I paid Rs. 48,500 then 2,85,000 and finally 12,34,567 rupees. '
    + 'Total loss 15,68,067. Also 500000 and 2000000 rupees.';
  assert.deepEqual(extract(amounts).entities, [], `extracted: ${JSON.stringify(extract(amounts).entities)}`);
});

test('an IFSC code does not leak as a bank account', () => {
  const text = 'Sent to account 50112233445 of HDFC Bank, IFSC HDFC0123456.';
  const accounts = extract(text).entities.filter((e) => e.type === 'BANK_ACCOUNT');
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].normalized_value, '50112233445');
});

test('a phone is not carved out of a longer account number', () => {
  // 98765432101 is 11 digits starting with 9. A phone pattern without digit
  // boundaries would happily take the first ten and invent a suspect number.
  const text = 'Account 98765432101 is eleven digits starting with nine.';
  assert.deepEqual(typesOf(text), ['BANK_ACCOUNT']);
  assert.equal(valueOf(text, 'BANK_ACCOUNT'), '98765432101');
});

test('a UPI id is not also reported as an email, and vice versa', () => {
  const text = 'Paid to rahul123@okaxis and got mail from priya.sharma42@gmail.com.';
  assert.deepEqual(typesOf(text), ['EMAIL', 'UPI']);
  assert.equal(valueOf(text, 'UPI'), 'rahul123@okaxis');
  assert.equal(valueOf(text, 'EMAIL'), 'priya.sharma42@gmail.com');
});

test('the @ inside an email does not become a Telegram handle', () => {
  const text = 'Mail came from scamdesk91@gmail.com only.';
  assert.deepEqual(typesOf(text), ['EMAIL']);
});

// ---------------------------------------------------------------------------
// Format tolerance
// ---------------------------------------------------------------------------

test('every way a person writes a phone number normalises to ten digits', () => {
  for (const written of [
    '+91 9876543210', '+919876543210', '09876543210',
    '9876543210', '98765-43210', '+91 98765 43210',
  ]) {
    assert.equal(
      valueOf(`Called from ${written} yesterday.`, 'PHONE'),
      '9876543210',
      `failed for "${written}"`
    );
  }
});

test('a UPI id in shouted case matches its lowercase twin', () => {
  // The generator uppercases a quarter of them, and two spellings of one
  // identifier that fail to converge means the network is never found.
  assert.equal(valueOf('Paid RAHUL@OKAXIS today.', 'UPI'), 'rahul@okaxis');
});

test('the same identifier named repeatedly is one entity', () => {
  const text = 'Paid rahul@okaxis twice. Again rahul@okaxis. And RAHUL@OKAXIS once more.';
  const upis = extract(text).entities.filter((e) => e.type === 'UPI');
  assert.equal(upis.length, 1, 'three mentions of one id must not inflate its graph degree');
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

test('repeated calls do not miss matches', () => {
  // The patterns are module-level and /g, so a forgotten lastIndex reset makes
  // the SECOND call resume mid-string and silently return less. This is exactly
  // the bug that would only appear on the second complaint of a demo.
  const first = extract(REAL_NARRATIVE).entities.length;
  const second = extract(REAL_NARRATIVE).entities.length;
  const third = extract(REAL_NARRATIVE).entities.length;
  assert.equal(first, second);
  assert.equal(second, third);
  assert.ok(first > 0);
});

test('empty and junk input return nothing rather than throwing', () => {
  for (const input of ['', '   ', null, undefined, 'no identifiers here at all']) {
    assert.deepEqual(extract(input).entities, [], `failed for ${JSON.stringify(input)}`);
  }
});

test('reports the shape the intake controller consumes', () => {
  const result = extract(REAL_NARRATIVE);
  assert.ok(Array.isArray(result.entities));
  assert.equal(typeof result.duration_ms, 'number');
  assert.equal(result.tiers.ner, 0, 'the Express tier has no NER and must never claim one');
  assert.equal(result.tiers.regex, result.entities.length);
  for (const entity of result.entities) {
    assert.equal(entity.method, 'REGEX');
    assert.ok(entity.confidence > 0 && entity.confidence <= 1);
    assert.ok(entity.normalized_value.length > 0);
  }
});
