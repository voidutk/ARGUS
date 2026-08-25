// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title EvidenceRegistry
 * @notice Tamper-evident chain of custody for ARGUS digital evidence.
 *
 * Stores ONLY a SHA-256 digest plus case metadata. Never the exhibit, never
 * ciphertext, never an encryption key, never a storage pointer, never victim
 * PII. Registering proves an exhibit existed in a given state at a given time
 * and has not changed since — nothing more.
 *
 * The part that matters for an investigation is getEvidenceHistory(). A single
 * anchor proves integrity at one instant; a court needs to see WHO checked the
 * exhibit, WHEN, and whether it still matched. Every verification is appended
 * here permanently, so the custody trail cannot be quietly rewritten later —
 * including the failures. An exhibit that stopped matching is exactly the fact
 * a defence would try to bury, so it is recorded on the same terms as a pass.
 *
 * Sealing marks an exhibit withdrawn from active use; it never deletes it. The
 * registry only ever grows, which is the entire point of a chain of custody.
 */
contract EvidenceRegistry is AccessControl, Pausable {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    struct Evidence {
        address registrar;      // relayer or investigator wallet that registered it
        uint64 registeredAt;    // block timestamp
        uint256 caseId;         // the off-chain complaints.id / investigations.id
        string evidenceType;    // SCREENSHOT | BANK_STATEMENT | CHAT_LOG | ...
        string unitCode;        // e.g. "CCPS-BLR"
        bool sealed_;           // withdrawn from active use, never removed
    }

    /// @dev One entry per integrity check, pass or fail. Append-only, forever.
    struct Verification {
        address verifier;
        // Named checkedAt, not `at`: ethers decodes structs into Result objects
        // that inherit Array.prototype, so a field called `at` is shadowed by
        // Array.prototype.at and reads back as a function on the client.
        uint64 checkedAt;
        bool matched;           // did the recomputed digest still match?
        string note;
    }

    mapping(bytes32 => Evidence) private _evidence;
    mapping(bytes32 => Verification[]) private _history;
    bytes32[] private _digests; // enumeration for the Evidence Locker ledger view

    event EvidenceRegistered(
        bytes32 indexed digest,
        uint256 indexed caseId,
        address indexed registrar,
        string evidenceType,
        string unitCode,
        uint64 registeredAt
    );

    event EvidenceVerified(
        bytes32 indexed digest,
        address indexed verifier,
        bool matched,
        string note,
        // Named checkedAt, not `at`, for the same reason as the Verification
        // struct above: ethers v6 decodes event args into Result objects that
        // inherit Array.prototype, so `at` reads back as a function.
        uint64 checkedAt
    );

    event EvidenceSealed(
        bytes32 indexed digest,
        address indexed by,
        string reason,
        uint64 sealedAt
    );

    error ZeroDigest();
    error AlreadyRegistered(bytes32 digest);
    error NotRegistered(bytes32 digest);
    error AlreadySealed(bytes32 digest);

    // `admin` starts out holding all three: DEFAULT_ADMIN_ROLE (OpenZeppelin's
    // built-in "root" role — can grant/revoke ADMIN_ROLE), ADMIN_ROLE (can
    // seal evidence, pause/unpause, and grant/revoke REGISTRAR_ROLE), and
    // REGISTRAR_ROLE (can register evidence and log verifications). In this
    // project that one address is the backend's relayer wallet — see
    // chainService.js's `init()`, which signs every transaction as this same
    // account. Extra investigator wallets can be granted REGISTRAR_ROLE later
    // via `grantRole()` (inherited from AccessControl) without touching this
    // contract again.
    constructor(address admin) {
        if (admin == address(0)) admin = msg.sender;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, admin);
        // ADMIN_ROLE administers who may register evidence.
        _setRoleAdmin(REGISTRAR_ROLE, ADMIN_ROLE);
    }

    /**
     * @notice Record an evidence digest on-chain.
     * @param digest SHA-256 of the PLAINTEXT exhibit, as bytes32.
     */
    function registerEvidence(
        bytes32 digest,
        uint256 caseId,
        string calldata evidenceType,
        string calldata unitCode
    ) external onlyRole(REGISTRAR_ROLE) whenNotPaused {
        if (digest == bytes32(0)) revert ZeroDigest();
        if (_evidence[digest].registeredAt != 0) revert AlreadyRegistered(digest);

        _evidence[digest] = Evidence({
            registrar: msg.sender,
            registeredAt: uint64(block.timestamp),
            caseId: caseId,
            evidenceType: evidenceType,
            unitCode: unitCode,
            sealed_: false
        });
        _digests.push(digest);

        emit EvidenceRegistered(
            digest, caseId, msg.sender, evidenceType, unitCode, uint64(block.timestamp)
        );
    }

    /// @notice The integrity check. Recompute an exhibit's digest, pass it here.
    function verifyEvidence(bytes32 digest)
        external
        view
        returns (bool exists, Evidence memory record)
    {
        record = _evidence[digest];
        exists = record.registeredAt != 0;
    }

    /// @notice Convenience boolean: registered AND not sealed.
    function isValid(bytes32 digest) external view returns (bool) {
        Evidence storage e = _evidence[digest];
        return e.registeredAt != 0 && !e.sealed_;
    }

    /**
     * @notice Append one custody entry. Called after every integrity check.
     * @dev Deliberately records `matched == false` too. Silently dropping failed
     *      checks would make the trail worthless as evidence.
     */
    function logVerification(bytes32 digest, bool matched, string calldata note)
        external
        onlyRole(REGISTRAR_ROLE)
        whenNotPaused
    {
        if (_evidence[digest].registeredAt == 0) revert NotRegistered(digest);

        _history[digest].push(Verification({
            verifier: msg.sender,
            checkedAt: uint64(block.timestamp),
            matched: matched,
            note: note
        }));

        emit EvidenceVerified(digest, msg.sender, matched, note, uint64(block.timestamp));
    }

    /// @notice The full custody trail for one exhibit, oldest first.
    function getEvidenceHistory(bytes32 digest) external view returns (Verification[] memory) {
        return _history[digest];
    }

    function historyLength(bytes32 digest) external view returns (uint256) {
        return _history[digest].length;
    }

    function sealEvidence(bytes32 digest, string calldata reason) external onlyRole(ADMIN_ROLE) {
        Evidence storage e = _evidence[digest];
        if (e.registeredAt == 0) revert NotRegistered(digest);
        if (e.sealed_) revert AlreadySealed(digest);
        e.sealed_ = true;
        emit EvidenceSealed(digest, msg.sender, reason, uint64(block.timestamp));
    }

    // `_digests` (declared up top) exists purely so the outside world can list
    // every exhibit ever registered, in order, without needing to already know
    // their hashes — a `mapping` alone has no way to enumerate its own keys.
    // This pair is what powers the Evidence Locker's ledger view: loop
    // `i` from 0 to totalRegistered(), call digestAt(i), then verifyEvidence()
    // on each to build the full list.
    function totalRegistered() external view returns (uint256) {
        return _digests.length;
    }

    function digestAt(uint256 index) external view returns (bytes32) {
        return _digests[index];
    }

    /// @notice Incident response: halt registration without touching what is recorded.
    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }
}
