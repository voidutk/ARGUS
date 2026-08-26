const { expect } = require('chai');
const { ethers } = require('hardhat');

const digestOf = (s) => ethers.sha256(ethers.toUtf8Bytes(s));

describe('EvidenceRegistry', function () {
  let registry, admin, registrar, outsider;

  beforeEach(async function () {
    [admin, registrar, outsider] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory('EvidenceRegistry');
    registry = await Factory.deploy(admin.address);
    await registry.waitForDeployment();
  });

  describe('registration', function () {
    it('records an exhibit and makes it verifiable', async function () {
      const digest = digestOf('whatsapp-screenshot.png');
      await registry.registerEvidence(digest, 4412, 'SCREENSHOT', 'CCPS-BLR');

      const [exists, record] = await registry.verifyEvidence(digest);
      expect(exists).to.equal(true);
      expect(record.caseId).to.equal(4412n);
      expect(record.evidenceType).to.equal('SCREENSHOT');
      expect(record.unitCode).to.equal('CCPS-BLR');
      expect(record.registrar).to.equal(admin.address);
      expect(record.sealed_).to.equal(false);
      expect(await registry.totalRegistered()).to.equal(1n);
    });

    it('reports a digest that was never registered as absent', async function () {
      const [exists] = await registry.verifyEvidence(digestOf('never-uploaded.pdf'));
      expect(exists).to.equal(false);
    });

    it('isValid is false for a digest that was never registered', async function () {
      expect(await registry.isValid(digestOf('never-uploaded.pdf'))).to.equal(false);
    });

    it('rejects a zero digest', async function () {
      await expect(
        registry.registerEvidence(ethers.ZeroHash, 1, 'DOCUMENT', 'CCPS-BLR')
      ).to.be.revertedWithCustomError(registry, 'ZeroDigest');
    });

    it('rejects the same digest twice', async function () {
      const digest = digestOf('statement.pdf');
      await registry.registerEvidence(digest, 1, 'BANK_STATEMENT', 'CCPS-BLR');
      await expect(
        registry.registerEvidence(digest, 2, 'BANK_STATEMENT', 'CCPS-HYD')
      ).to.be.revertedWithCustomError(registry, 'AlreadyRegistered');
    });

    it('emits EvidenceRegistered with the case reference', async function () {
      const digest = digestOf('chat.txt');
      await expect(registry.registerEvidence(digest, 991, 'CHAT_LOG', 'CCPS-MUM'))
        .to.emit(registry, 'EvidenceRegistered')
        .withArgs(digest, 991, admin.address, 'CHAT_LOG', 'CCPS-MUM', anyUint());
    });
  });

  describe('chain of custody', function () {
    let digest;

    beforeEach(async function () {
      digest = digestOf('exhibit-a.png');
      await registry.registerEvidence(digest, 4412, 'SCREENSHOT', 'CCPS-BLR');
    });

    it('starts empty and grows by one per verification', async function () {
      expect(await registry.historyLength(digest)).to.equal(0n);

      await registry.logVerification(digest, true, 'intake check');
      await registry.logVerification(digest, true, 're-check before filing');

      expect(await registry.historyLength(digest)).to.equal(2n);
      const history = await registry.getEvidenceHistory(digest);
      expect(history).to.have.lengthOf(2);
      expect(history[0].note).to.equal('intake check');
      expect(history[0].verifier).to.equal(admin.address);
      expect(history[1].note).to.equal('re-check before filing');
    });

    it('records a FAILED check just as permanently as a passing one', async function () {
      // The whole point: a tampered exhibit must leave a mark nobody can remove.
      await registry.logVerification(digest, true, 'intake check');
      await registry.logVerification(digest, false, 'digest mismatch on re-check');

      const history = await registry.getEvidenceHistory(digest);
      expect(history).to.have.lengthOf(2);
      expect(history[0].matched).to.equal(true);
      expect(history[1].matched).to.equal(false);
      expect(history[1].note).to.equal('digest mismatch on re-check');
    });

    it('preserves order oldest first', async function () {
      await registry.logVerification(digest, true, 'first');
      await registry.logVerification(digest, true, 'second');
      await registry.logVerification(digest, true, 'third');

      const history = await registry.getEvidenceHistory(digest);
      expect(history.map((h) => h.note)).to.deep.equal(['first', 'second', 'third']);
      expect(history[0].checkedAt).to.be.lte(history[2].checkedAt);
    });

    it('refuses to log against an unregistered digest', async function () {
      await expect(
        registry.logVerification(digestOf('ghost.png'), true, 'nope')
      ).to.be.revertedWithCustomError(registry, 'NotRegistered');
    });
  });

  describe('access control', function () {
    it('blocks a non-registrar from registering', async function () {
      await expect(
        registry.connect(outsider).registerEvidence(digestOf('x'), 1, 'DOCUMENT', 'CCPS-BLR')
      ).to.be.revertedWithCustomError(registry, 'AccessControlUnauthorizedAccount');
    });

    it('blocks a non-registrar from writing custody entries', async function () {
      const digest = digestOf('y');
      await registry.registerEvidence(digest, 1, 'DOCUMENT', 'CCPS-BLR');
      await expect(
        registry.connect(outsider).logVerification(digest, false, 'forged entry')
      ).to.be.revertedWithCustomError(registry, 'AccessControlUnauthorizedAccount');
    });

    it('lets an admin grant REGISTRAR_ROLE', async function () {
      const role = await registry.REGISTRAR_ROLE();
      await registry.grantRole(role, registrar.address);
      await expect(
        registry.connect(registrar).registerEvidence(digestOf('z'), 5, 'CALL_RECORD', 'CCPS-DEL')
      ).to.not.be.reverted;
    });

    it('revoking REGISTRAR_ROLE takes effect immediately', async function () {
      const role = await registry.REGISTRAR_ROLE();
      await registry.grantRole(role, registrar.address);
      await registry.connect(registrar).registerEvidence(digestOf('revoke-1'), 1, 'DOCUMENT', 'CCPS-BLR');

      await registry.revokeRole(role, registrar.address);

      await expect(
        registry.connect(registrar).registerEvidence(digestOf('revoke-2'), 2, 'DOCUMENT', 'CCPS-BLR')
      ).to.be.revertedWithCustomError(registry, 'AccessControlUnauthorizedAccount');
    });

    it('blocks a non-admin from sealing', async function () {
      const digest = digestOf('w');
      await registry.registerEvidence(digest, 1, 'DOCUMENT', 'CCPS-BLR');
      await expect(
        registry.connect(outsider).sealEvidence(digest, 'case closed')
      ).to.be.revertedWithCustomError(registry, 'AccessControlUnauthorizedAccount');
    });
  });

  describe('sealing', function () {
    it('marks withdrawn without deleting the record or its history', async function () {
      const digest = digestOf('sealed-exhibit.pdf');
      await registry.registerEvidence(digest, 77, 'DOCUMENT', 'CCPS-BLR');
      await registry.logVerification(digest, true, 'intake');
      await registry.sealEvidence(digest, 'case closed');

      const [exists, record] = await registry.verifyEvidence(digest);
      expect(exists).to.equal(true);           // still there
      expect(record.sealed_).to.equal(true);
      expect(await registry.isValid(digest)).to.equal(false);
      expect(await registry.historyLength(digest)).to.equal(1n);  // trail survives
      expect(await registry.totalRegistered()).to.equal(1n);
    });

    it('rejects sealing twice', async function () {
      const digest = digestOf('once.pdf');
      await registry.registerEvidence(digest, 1, 'DOCUMENT', 'CCPS-BLR');
      await registry.sealEvidence(digest, 'first');
      await expect(
        registry.sealEvidence(digest, 'second')
      ).to.be.revertedWithCustomError(registry, 'AlreadySealed');
    });
  });

  describe('pause', function () {
    it('halts registration but never reads', async function () {
      const digest = digestOf('before-pause.png');
      await registry.registerEvidence(digest, 1, 'SCREENSHOT', 'CCPS-BLR');
      await registry.pause();

      await expect(
        registry.registerEvidence(digestOf('during-pause.png'), 2, 'SCREENSHOT', 'CCPS-BLR')
      ).to.be.revertedWithCustomError(registry, 'EnforcedPause');

      // Reads must keep working — an investigation in progress cannot stall.
      const [exists] = await registry.verifyEvidence(digest);
      expect(exists).to.equal(true);

      await registry.unpause();
      await expect(
        registry.registerEvidence(digestOf('after-pause.png'), 3, 'SCREENSHOT', 'CCPS-BLR')
      ).to.not.be.reverted;
    });

    it('sealing has no whenNotPaused guard — an admin can still withdraw an exhibit mid-incident', async function () {
      const digest = digestOf('seal-during-pause.png');
      await registry.registerEvidence(digest, 1, 'SCREENSHOT', 'CCPS-BLR');
      await registry.pause();

      await expect(registry.sealEvidence(digest, 'withdrawn while paused')).to.not.be.reverted;
      expect((await registry.verifyEvidence(digest)).record.sealed_).to.equal(true);
    });
  });

  describe('event field naming (ethers v6 Result/Array.prototype collision)', function () {
    // Regression test: the Verification struct's timestamp is deliberately
    // named `checkedAt` instead of `at` because ethers v6 decodes structs
    // (and event args) into Result objects that inherit Array.prototype, so a
    // field literally named `at` reads back as Array.prototype.at (a
    // function) instead of the timestamp. The same collision was present in
    // the EvidenceVerified/EvidenceSealed event signatures until this fix.
    it('exposes the verification timestamp as checkedAt on EvidenceVerified, not `at`', async function () {
      const digest = digestOf('event-field-check.png');
      await registry.registerEvidence(digest, 1, 'DOCUMENT', 'CCPS-BLR');
      const tx = await registry.logVerification(digest, true, 'intake check');
      const receipt = await tx.wait();

      const event = receipt.logs
        .map((log) => { try { return registry.interface.parseLog(log); } catch { return null; } })
        .find((e) => e && e.name === 'EvidenceVerified');

      expect(event).to.not.equal(undefined);
      expect(event.args.checkedAt).to.be.a('bigint');
      expect(event.args.checkedAt).to.be.greaterThan(0n);
    });

    it('exposes the seal timestamp as sealedAt on EvidenceSealed, not `at`', async function () {
      const digest = digestOf('seal-event-field-check.pdf');
      await registry.registerEvidence(digest, 1, 'DOCUMENT', 'CCPS-BLR');
      const tx = await registry.sealEvidence(digest, 'case closed');
      const receipt = await tx.wait();

      const event = receipt.logs
        .map((log) => { try { return registry.interface.parseLog(log); } catch { return null; } })
        .find((e) => e && e.name === 'EvidenceSealed');

      expect(event).to.not.equal(undefined);
      expect(event.args.sealedAt).to.be.a('bigint');
      expect(event.args.sealedAt).to.be.greaterThan(0n);
    });
  });

  describe('enumeration', function () {
    it('lists every digest in registration order', async function () {
      const a = digestOf('a'); const b = digestOf('b');
      await registry.registerEvidence(a, 1, 'DOCUMENT', 'CCPS-BLR');
      await registry.registerEvidence(b, 2, 'DOCUMENT', 'CCPS-BLR');

      expect(await registry.totalRegistered()).to.equal(2n);
      expect(await registry.digestAt(0)).to.equal(a);
      expect(await registry.digestAt(1)).to.equal(b);
    });

    it('reverts reading past the end of the digest list', async function () {
      await registry.registerEvidence(digestOf('only-one'), 1, 'DOCUMENT', 'CCPS-BLR');
      await expect(registry.digestAt(1)).to.be.reverted; // Solidity array out-of-bounds panic
    });
  });
});

// Loose matcher for block timestamps in event args.
function anyUint() {
  const { anyValue } = require('@nomicfoundation/hardhat-chai-matchers/withArgs');
  return anyValue;
}
