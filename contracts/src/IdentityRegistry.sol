// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

/// @title IdentityRegistry
/// @notice ERC-8004–style agent identities. Each agent is an ERC-721 token owned by its operator and
///         bound to an `agentWallet` — the hot key the agent signs and transacts with.
contract IdentityRegistry is ERC721URIStorage {
    enum Role {
        None,
        Trader,
        Validator,
        Challenger
    }

    struct AgentInfo {
        Role role;
        address agentWallet;
        uint64 registeredAt;
    }

    uint256 public totalAgents;
    mapping(uint256 agentId => AgentInfo) private _agents;
    mapping(address wallet => uint256 agentId) public agentIdOfWallet;

    /// @dev Event name matches the ERC-8004 Identity Registry.
    event Registered(uint256 indexed agentId, string tokenURI, address indexed owner);
    event AgentRegistered(uint256 indexed agentId, Role role, address indexed agentWallet);

    error InvalidRole();
    error WalletAlreadyRegistered(address wallet);
    error ZeroWallet();

    constructor() ERC721("Talidator Agent Identity", "TAID") {}

    /// @notice Mint an identity to msg.sender for an agent that transacts from `agentWallet`.
    function register(string calldata tokenURI_, Role role, address wallet) external returns (uint256 agentId) {
        if (role == Role.None) revert InvalidRole();
        if (wallet == address(0)) revert ZeroWallet();
        if (agentIdOfWallet[wallet] != 0) revert WalletAlreadyRegistered(wallet);

        agentId = ++totalAgents;
        _mint(msg.sender, agentId);
        _setTokenURI(agentId, tokenURI_);
        _agents[agentId] = AgentInfo(role, wallet, uint64(block.timestamp));
        agentIdOfWallet[wallet] = agentId;

        emit Registered(agentId, tokenURI_, msg.sender);
        emit AgentRegistered(agentId, role, wallet);
    }

    function getAgent(uint256 agentId) external view returns (AgentInfo memory) {
        _requireOwned(agentId);
        return _agents[agentId];
    }

    function roleOf(uint256 agentId) external view returns (Role) {
        return _agents[agentId].role;
    }

    function agentWallet(uint256 agentId) external view returns (address) {
        return _agents[agentId].agentWallet;
    }

    /// @notice True if `account` is the token owner or the agent's bound wallet.
    function isAuthorized(uint256 agentId, address account) public view returns (bool) {
        address owner = _ownerOf(agentId);
        return owner != address(0) && (account == owner || account == _agents[agentId].agentWallet);
    }
}
