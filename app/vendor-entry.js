// Bundled into app/vendor/viem.js by `npm run build:app` so the console runs with no CDN.
export {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  defineChain,
  parseUnits,
  formatUnits,
  toHex,
  hexToString,
  keccak256,
  getAddress,
  isAddress,
  parseEventLogs,
  BaseError,
  ContractFunctionRevertedError,
} from "viem";
export { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
