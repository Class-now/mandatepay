// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev The EIP-3009 function tUSD8 exposes (USDC-style).
interface IERC3009Receive {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title MandateVault
/// @notice Spending mandates for AI agents, paid in tUSD8 on QDay Aevum.
///
///         A person or business (the "owner") keeps tUSD8 in the vault and hands each agent a
///         mandate instead of a wallet: a session key that can pay only allow-listed merchants,
///         only up to a per-payment cap and a rolling budget, only until it expires, and only until
///         the owner revokes it. Payments above a review threshold are not paid; they wait for the
///         owner's one-tap approval (human in the loop). Every payment carries a reference
///         (invoice or order id) that can be paid once per mandate, so an agent that retries after a
///         timeout cannot pay twice.
///
///         Agents never need gas: they sign a `PaymentIntent` (EIP-712) and any relayer submits it.
///         Contract wallets can be agents too (ERC-1271 via SignatureChecker).
contract MandateVault is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ types

    struct Mandate {
        address owner;
        address agent; // session key (EOA) or ERC-1271 contract
        uint64 expiresAt; // unix seconds; payments at or after this fail
        uint64 period; // budget window in seconds (e.g. 86400 = daily)
        uint64 periodStart; // start of the current window
        bool revoked;
        bool anyMerchant; // true when created with an empty allow-list
        uint128 perTxCap; // largest single payment
        uint128 budget; // total allowed per window
        uint128 spent; // spent (or held for review) in the current window
        uint128 reviewAbove; // payments strictly above this wait for the owner; type(uint128).max = never
        bytes32 label; // short human label, e.g. "travel-bot"
    }

    enum PendingStatus {
        None,
        Waiting,
        Approved,
        Rejected,
        Expired
    }

    struct Pending {
        uint256 mandateId;
        address merchant;
        uint128 amount;
        uint64 requestedAt;
        uint64 expiresAt;
        uint64 periodStart; // window the amount was counted against
        PendingStatus status;
        bytes32 ref;
    }

    enum Outcome {
        Paid,
        Escalated
    }

    // ------------------------------------------------------------- constants

    bytes32 public constant PAYMENT_INTENT_TYPEHASH = keccak256(
        "PaymentIntent(uint256 mandateId,address merchant,uint256 amount,bytes32 ref,uint256 deadline)"
    );

    /// @notice How long an escalated payment waits for the owner before anyone can release it.
    uint64 public constant REVIEW_WINDOW = 3 days;

    IERC20 public immutable token;

    // ----------------------------------------------------------------- state

    mapping(address owner => uint256) public balanceOf; // free balance, not yet spent or held
    mapping(address owner => uint256) public heldOf; // held for escalated payments
    mapping(address owner => bool) public frozen; // owner-wide kill switch

    uint256 public mandateCount;
    mapping(uint256 id => Mandate) private _mandates;
    mapping(uint256 id => mapping(address merchant => bool)) public merchantAllowed;
    mapping(uint256 id => mapping(bytes32 ref => bool)) public refUsed;

    uint256 public pendingCount;
    mapping(uint256 pendingId => Pending) private _pending;

    // ---------------------------------------------------------------- events

    event Deposited(address indexed owner, address indexed from, uint256 amount);
    event Withdrawn(address indexed owner, address indexed to, uint256 amount);
    event MandateCreated(
        uint256 indexed mandateId,
        address indexed owner,
        address indexed agent,
        bytes32 label,
        uint256 perTxCap,
        uint256 budget,
        uint64 period,
        uint64 expiresAt,
        uint256 reviewAbove,
        bool anyMerchant
    );
    event MandateLimitsUpdated(
        uint256 indexed mandateId, uint256 perTxCap, uint256 budget, uint256 reviewAbove, uint64 expiresAt
    );
    event MerchantSet(uint256 indexed mandateId, address indexed merchant, bool allowed);
    event MandateRevoked(uint256 indexed mandateId);
    event OwnerFrozen(address indexed owner, bool frozen);
    event Paid(
        uint256 indexed mandateId,
        address indexed merchant,
        address indexed agent,
        uint256 amount,
        bytes32 ref,
        uint256 pendingId
    );
    event PaymentEscalated(
        uint256 indexed pendingId, uint256 indexed mandateId, address indexed merchant, uint256 amount, bytes32 ref
    );
    event EscalationResolved(uint256 indexed pendingId, PendingStatus status);

    // ---------------------------------------------------------------- errors

    error NotOwner();
    error NotAgent();
    error UnknownMandate();
    error MandateRevokedError();
    error MandateExpired();
    error OwnerIsFrozen();
    error MerchantNotAllowed();
    error OverPerTxCap();
    error OverBudget();
    error RefAlreadyUsed();
    error InsufficientBalance();
    error IntentExpired();
    error BadSignature();
    error BadParams();
    error NotWaiting();
    error ReviewWindowOpen();

    constructor(IERC20 token_) EIP712("MandateVault", "1") {
        token = token_;
    }

    // ------------------------------------------------------------ funding

    /// @notice Deposit with a prior `approve`.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert BadParams();
        token.safeTransferFrom(msg.sender, address(this), amount);
        balanceOf[msg.sender] += amount;
        emit Deposited(msg.sender, msg.sender, amount);
    }

    /// @notice Gasless deposit: `from` signs an EIP-3009 ReceiveWithAuthorization to this vault and
    ///         anyone submits it. The deposit is credited to `from`.
    function depositWithAuthorization(
        address from,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        if (amount == 0) revert BadParams();
        uint256 before = token.balanceOf(address(this));
        IERC3009Receive(address(token)).receiveWithAuthorization(
            from, address(this), amount, validAfter, validBefore, nonce, v, r, s
        );
        if (token.balanceOf(address(this)) - before != amount) revert BadParams();
        balanceOf[from] += amount;
        emit Deposited(from, from, amount);
    }

    function withdraw(uint256 amount, address to) external nonReentrant {
        if (to == address(0)) revert BadParams();
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        balanceOf[msg.sender] -= amount;
        token.safeTransfer(to, amount);
        emit Withdrawn(msg.sender, to, amount);
    }

    // ------------------------------------------------------------ mandates

    /// @param merchants allow-list. Empty means the agent may pay any merchant (still capped).
    /// @param reviewAbove payments strictly above this need owner approval. Use type(uint128).max for never.
    function createMandate(
        address agent,
        uint128 perTxCap,
        uint128 budget,
        uint64 period,
        uint64 expiresAt,
        uint128 reviewAbove,
        bytes32 label,
        address[] calldata merchants
    ) external returns (uint256 id) {
        if (agent == address(0) || agent == msg.sender) revert BadParams();
        if (perTxCap == 0 || budget == 0 || perTxCap > budget || period == 0) revert BadParams();
        if (expiresAt <= block.timestamp) revert BadParams();

        id = ++mandateCount;
        Mandate storage m = _mandates[id];
        m.owner = msg.sender;
        m.agent = agent;
        m.expiresAt = expiresAt;
        m.period = period;
        m.periodStart = uint64(block.timestamp);
        m.perTxCap = perTxCap;
        m.budget = budget;
        m.reviewAbove = reviewAbove;
        m.label = label;
        m.anyMerchant = merchants.length == 0;

        emit MandateCreated(
            id, msg.sender, agent, label, perTxCap, budget, period, expiresAt, reviewAbove, m.anyMerchant
        );
        for (uint256 i; i < merchants.length; ++i) {
            if (merchants[i] == address(0)) revert BadParams();
            merchantAllowed[id][merchants[i]] = true;
            emit MerchantSet(id, merchants[i], true);
        }
    }

    function updateLimits(uint256 id, uint128 perTxCap, uint128 budget, uint128 reviewAbove, uint64 expiresAt)
        external
    {
        Mandate storage m = _ownedMandate(id);
        if (perTxCap == 0 || budget == 0 || perTxCap > budget) revert BadParams();
        m.perTxCap = perTxCap;
        m.budget = budget;
        m.reviewAbove = reviewAbove;
        m.expiresAt = expiresAt;
        emit MandateLimitsUpdated(id, perTxCap, budget, reviewAbove, expiresAt);
    }

    /// @notice Adding a merchant to an "any merchant" mandate turns it into an allow-list mandate.
    function setMerchant(uint256 id, address merchant, bool allowed) external {
        Mandate storage m = _ownedMandate(id);
        if (merchant == address(0)) revert BadParams();
        if (allowed) m.anyMerchant = false;
        merchantAllowed[id][merchant] = allowed;
        emit MerchantSet(id, merchant, allowed);
    }

    /// @notice Instant and final. The agent's key stops working in the same block.
    function revoke(uint256 id) external {
        Mandate storage m = _ownedMandate(id);
        m.revoked = true;
        emit MandateRevoked(id);
    }

    /// @notice Kill switch for every mandate of the caller. Reversible.
    function setFrozen(bool value) external {
        frozen[msg.sender] = value;
        emit OwnerFrozen(msg.sender, value);
    }

    // ------------------------------------------------------------- paying

    /// @notice The agent pays directly (it holds gas).
    function pay(uint256 id, address merchant, uint256 amount, bytes32 ref)
        external
        nonReentrant
        returns (Outcome outcome, uint256 pendingId)
    {
        if (msg.sender != _mandates[id].agent) revert NotAgent();
        return _pay(id, merchant, amount, ref);
    }

    /// @notice Gasless: the agent signs a PaymentIntent and anyone (a relayer) submits it.
    function payWithSig(
        uint256 id,
        address merchant,
        uint256 amount,
        bytes32 ref,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant returns (Outcome outcome, uint256 pendingId) {
        if (block.timestamp > deadline) revert IntentExpired();
        address agent = _mandates[id].agent;
        if (agent == address(0)) revert UnknownMandate();
        bytes32 digest = intentDigest(id, merchant, amount, ref, deadline);
        if (!SignatureChecker.isValidSignatureNow(agent, digest, signature)) revert BadSignature();
        return _pay(id, merchant, amount, ref);
    }

    function _pay(uint256 id, address merchant, uint256 amount, bytes32 ref)
        private
        returns (Outcome outcome, uint256 pendingId)
    {
        Mandate storage m = _mandates[id];
        if (m.owner == address(0)) revert UnknownMandate();
        if (m.revoked) revert MandateRevokedError();
        if (block.timestamp >= m.expiresAt) revert MandateExpired();
        if (frozen[m.owner]) revert OwnerIsFrozen();
        if (merchant == address(0) || (!m.anyMerchant && !merchantAllowed[id][merchant])) {
            revert MerchantNotAllowed();
        }
        if (amount == 0) revert BadParams();
        if (amount > m.perTxCap) revert OverPerTxCap();
        if (refUsed[id][ref]) revert RefAlreadyUsed();

        _roll(m);
        if (uint256(m.spent) + amount > m.budget) revert OverBudget();
        if (balanceOf[m.owner] < amount) revert InsufficientBalance();

        refUsed[id][ref] = true;
        m.spent += uint128(amount);
        balanceOf[m.owner] -= amount;

        if (amount > m.reviewAbove) {
            heldOf[m.owner] += amount;
            pendingId = ++pendingCount;
            _pending[pendingId] = Pending({
                mandateId: id,
                merchant: merchant,
                amount: uint128(amount),
                requestedAt: uint64(block.timestamp),
                expiresAt: uint64(block.timestamp) + REVIEW_WINDOW,
                periodStart: m.periodStart,
                status: PendingStatus.Waiting,
                ref: ref
            });
            emit PaymentEscalated(pendingId, id, merchant, amount, ref);
            return (Outcome.Escalated, pendingId);
        }

        token.safeTransfer(merchant, amount);
        emit Paid(id, merchant, m.agent, amount, ref, 0);
        return (Outcome.Paid, 0);
    }

    // ------------------------------------------------------------ review

    function approvePending(uint256 pendingId) external nonReentrant {
        Pending storage p = _pending[pendingId];
        if (p.status != PendingStatus.Waiting) revert NotWaiting();
        Mandate storage m = _mandates[p.mandateId];
        if (msg.sender != m.owner) revert NotOwner();
        if (block.timestamp >= p.expiresAt) revert MandateExpired();
        p.status = PendingStatus.Approved;
        heldOf[m.owner] -= p.amount;
        token.safeTransfer(p.merchant, p.amount);
        emit EscalationResolved(pendingId, PendingStatus.Approved);
        emit Paid(p.mandateId, p.merchant, m.agent, p.amount, p.ref, pendingId);
    }

    function rejectPending(uint256 pendingId) external {
        Pending storage p = _pending[pendingId];
        if (p.status != PendingStatus.Waiting) revert NotWaiting();
        if (msg.sender != _mandates[p.mandateId].owner) revert NotOwner();
        _release(pendingId, p, PendingStatus.Rejected);
    }

    /// @notice After the review window anyone can return an unanswered request's funds to the owner.
    function expirePending(uint256 pendingId) external {
        Pending storage p = _pending[pendingId];
        if (p.status != PendingStatus.Waiting) revert NotWaiting();
        if (block.timestamp < p.expiresAt) revert ReviewWindowOpen();
        _release(pendingId, p, PendingStatus.Expired);
    }

    /// @dev Returns held funds to the owner and gives the budget back if the window hasn't rolled.
    ///      The ref stays used: a rejected invoice must be re-issued, not silently retried.
    function _release(uint256 pendingId, Pending storage p, PendingStatus status) private {
        Mandate storage m = _mandates[p.mandateId];
        p.status = status;
        heldOf[m.owner] -= p.amount;
        balanceOf[m.owner] += p.amount;
        _roll(m);
        if (m.periodStart == p.periodStart) {
            m.spent = m.spent > p.amount ? m.spent - p.amount : 0;
        }
        emit EscalationResolved(pendingId, status);
    }

    // ------------------------------------------------------------- views

    function getMandate(uint256 id) external view returns (Mandate memory m) {
        m = _mandates[id];
        if (m.owner != address(0) && block.timestamp >= uint256(m.periodStart) + m.period) {
            uint64 elapsed = uint64(block.timestamp) - m.periodStart;
            m.periodStart += (elapsed / m.period) * m.period;
            m.spent = 0;
        }
    }

    function getPending(uint256 pendingId) external view returns (Pending memory) {
        return _pending[pendingId];
    }

    /// @notice What the agent could pay right now in one payment (0 if it can't pay at all).
    function spendableNow(uint256 id) external view returns (uint256) {
        Mandate memory m = this.getMandate(id);
        if (m.owner == address(0) || m.revoked || block.timestamp >= m.expiresAt || frozen[m.owner]) return 0;
        uint256 left = m.budget - m.spent;
        if (left > m.perTxCap) left = m.perTxCap;
        if (left > balanceOf[m.owner]) left = balanceOf[m.owner];
        return left;
    }

    function intentDigest(uint256 id, address merchant, uint256 amount, bytes32 ref, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(PAYMENT_INTENT_TYPEHASH, id, merchant, amount, ref, deadline)));
    }

    // ----------------------------------------------------------- internal

    function _ownedMandate(uint256 id) private view returns (Mandate storage m) {
        m = _mandates[id];
        if (m.owner == address(0)) revert UnknownMandate();
        if (m.owner != msg.sender) revert NotOwner();
    }

    function _roll(Mandate storage m) private {
        if (block.timestamp >= uint256(m.periodStart) + m.period) {
            uint64 elapsed = uint64(block.timestamp) - m.periodStart;
            m.periodStart += (elapsed / m.period) * m.period;
            m.spent = 0;
        }
    }
}
