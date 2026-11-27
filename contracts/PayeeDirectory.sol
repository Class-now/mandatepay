// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PayeeDirectory
/// @notice Confirmation of Payee and agent identity for MandatePay, kept in our own contract.
///
///         QDay's ERC-8004 registry is still in internal testing and is not open for the Aevum
///         Builder Challenge (Aevum Starter Kit docs, 2026-11-20), so the name-to-address mapping
///         lives here, with the same two questions an ERC-8004 registry answers:
///
///         1. Merchants: "is `coffee-shop` really this address?" A merchant claims a unique handle
///            from its own address. Before an agent signs a payment intent it resolves the handle
///            and checks it against the address it was about to pay (`confirmPayee`), so a
///            look-alike address pasted into a prompt or an invoice is caught before money moves.
///         2. Agents: "which agent paid, on whose behalf?" The owner who issues a mandate declares
///            the session key's handle and a metadata URI (an agent card). The session key then
///            accepts it with one EIP-712 signature (no gas; anyone can relay it), so a declared
///            identity is only "confirmed" when both sides agree. Merchants read `agentOf` to show
///            the agent's name and its principal next to every `Paid` event.
///
///         Handles are lowercase a-z, 0-9 and '-', 3 to 32 characters, so "Coffee-Shop" and
///         "coffee-shop" cannot both exist.
contract PayeeDirectory {
    struct Merchant {
        address account;
        string handle;
        string uri; // optional profile: website, receipt endpoint, etc.
        uint64 registeredAt;
    }

    struct Agent {
        address principal; // who declared the agent (the mandate owner)
        string handle;
        string uri; // agent card (JSON): model, operator, contact
        uint64 declaredAt;
        bool confirmed; // the session key itself accepted the declaration
    }

    bytes32 public constant ACCEPT_TYPEHASH = keccak256("AcceptAgent(address agent,address principal,bytes32 handle)");
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    mapping(bytes32 handleHash => address) public merchantByHandle;
    mapping(address => Merchant) private _merchants;
    mapping(address agent => Agent) private _agents;

    event MerchantRegistered(address indexed account, bytes32 indexed handleHash, string handle, string uri);
    event MerchantReleased(address indexed account, bytes32 indexed handleHash);
    event AgentDeclared(address indexed agent, address indexed principal, string handle, string uri);
    event AgentConfirmed(address indexed agent, address indexed principal);

    error BadHandle();
    error HandleTaken();
    error AlreadyRegistered();
    error NotRegistered();
    error NotPrincipal();
    error BadSignature();

    // -------------------------------------------------------------- merchants

    /// @notice Claim `handle` for msg.sender. One handle per address; release it to change it.
    function registerMerchant(string calldata handle, string calldata uri) external {
        bytes32 h = _checkHandle(handle);
        if (merchantByHandle[h] != address(0)) revert HandleTaken();
        if (_merchants[msg.sender].account != address(0)) revert AlreadyRegistered();
        merchantByHandle[h] = msg.sender;
        _merchants[msg.sender] = Merchant(msg.sender, handle, uri, uint64(block.timestamp));
        emit MerchantRegistered(msg.sender, h, handle, uri);
    }

    function releaseMerchant() external {
        Merchant storage m = _merchants[msg.sender];
        if (m.account == address(0)) revert NotRegistered();
        bytes32 h = keccak256(bytes(m.handle));
        delete merchantByHandle[h];
        delete _merchants[msg.sender];
        emit MerchantReleased(msg.sender, h);
    }

    /// @notice The address that owns `handle`, or address(0).
    function resolve(string calldata handle) external view returns (address) {
        return merchantByHandle[keccak256(bytes(handle))];
    }

    /// @notice True only when `handle` is registered to exactly `account`.
    function confirmPayee(string calldata handle, address account) external view returns (bool) {
        return account != address(0) && merchantByHandle[keccak256(bytes(handle))] == account;
    }

    function merchantOf(address account) external view returns (Merchant memory) {
        return _merchants[account];
    }

    // ----------------------------------------------------------------- agents

    /// @notice Declare (or re-declare) the identity of session key `agent`. Re-declaring by a
    ///         different principal, or with a new handle, clears the confirmation.
    function declareAgent(address agent, string calldata handle, string calldata uri) external {
        _checkHandle(handle);
        Agent storage a = _agents[agent];
        if (a.principal != address(0) && a.principal != msg.sender) revert NotPrincipal();
        bool keep = a.confirmed && keccak256(bytes(a.handle)) == keccak256(bytes(handle));
        _agents[agent] = Agent(msg.sender, handle, uri, uint64(block.timestamp), keep);
        emit AgentDeclared(agent, msg.sender, handle, uri);
    }

    /// @notice The principal removes its declaration (e.g. after revoking the mandate).
    function removeAgent(address agent) external {
        if (_agents[agent].principal != msg.sender) revert NotPrincipal();
        delete _agents[agent];
        emit AgentDeclared(agent, address(0), "", "");
    }

    /// @notice The session key accepts its declared identity. Gasless: anyone may submit the
    ///         agent's EIP-712 signature over (agent, principal, keccak256(handle)).
    function acceptAgent(address agent, bytes calldata signature) external {
        Agent storage a = _agents[agent];
        if (a.principal == address(0)) revert NotRegistered();
        bytes32 digest = acceptDigest(agent, a.principal, a.handle);
        if (_recover(digest, signature) != agent) revert BadSignature();
        a.confirmed = true;
        emit AgentConfirmed(agent, a.principal);
    }

    function agentOf(address agent) external view returns (Agent memory) {
        return _agents[agent];
    }

    function acceptDigest(address agent, address principal, string memory handle) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(ACCEPT_TYPEHASH, agent, principal, keccak256(bytes(handle))));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(_DOMAIN_TYPEHASH, keccak256("PayeeDirectory"), keccak256("1"), block.chainid, address(this))
        );
    }

    // ---------------------------------------------------------------- helpers

    function _checkHandle(string calldata handle) private pure returns (bytes32) {
        bytes calldata b = bytes(handle);
        if (b.length < 3 || b.length > 32) revert BadHandle();
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            bool ok = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x2d;
            if (!ok) revert BadHandle();
        }
        return keccak256(b);
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        // reject malleable signatures (upper half of s)
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
