export {
  isNativePlatform,
  getPlatform,
  startNativeTimer,
  updateNativeTimer,
  refreshIosTimerNotification,
  stopNativeTimer,
  initNativeTimer,
} from './bridge.js';

export { nativeBiometricAvailable, nativeBiometricAuthenticate } from './biometric.js';
