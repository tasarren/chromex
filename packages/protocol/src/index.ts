// Public contract shared by the extension worker, the native host, the MCP server and setup.
// Browser-safe: no Node APIs.

export { CONFIG_DIRECTORY, CONFIG_FILE, configHome, hasDisplayEnv, MANAGED_ENVIRONMENT_FILE, MANAGED_ENVIRONMENT_KEYS } from "./constants.ts"
export { AgentCursor, CursorUnavailable, formatPointerState, formatScreenshotLine, type PointerState, type ScreenshotPath } from "./cursor.ts"
export { type FieldFocus, hasWheel, type InputCommand, type InputOperation, runInput, withCleanup } from "./input.ts"
export { type InspectRequest, parseInspection, type ScreenshotPage, runInspection } from "./inspection.ts"
export {
  type Admitted,
  type DocumentIdentity,
  type ExecutorAuthority,
  executeStep,
  parseAdmitted,
  parsePointerArgs,
  type Point,
  type PointerArgs,
  type GestureState,
  type PointerTarget,
  REPLACED_WARNING,
  readDocument,
  replacesDocument,
  runPointerStep,
  type StepAnswer,
  StepRefused,
  type StepSession,
  StepUncertain,
} from "./pointer.ts"
export {
  errorMessage,
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  type ExtensionInfo,
  NATIVE_HOST_NAME,
  parseRpcRequest,
  parseRpcResponse,
  PROTOCOL_VERSION,
  type RpcId,
  type RpcRequest,
  type RpcResponse,
  rpcError,
  rpcResult,
  STORE_EXTENSION_ID,
  type TabInfo,
} from "./rpc.ts"
