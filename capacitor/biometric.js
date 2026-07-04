import { BiometricAuth } from '@aparajita/capacitor-biometric-auth';
import { isNativePlatform } from './bridge.js';

// Native Face ID / Touch ID / Android BiometricPrompt, used instead of raw
// WebAuthn inside the app's WKWebView/Android WebView — platform-authenticator
// WebAuthn there requires Associated Domains entitlements to persist reliably,
// which this app's `rp.id` ('localhost') never had, so credentials could
// silently fail to survive across app sessions on iOS.

export async function nativeBiometricAvailable() {
  if (!isNativePlatform()) return false;
  try {
    const result = await BiometricAuth.checkBiometry();
    return !!result.isAvailable;
  } catch {
    return false;
  }
}

export async function nativeBiometricAuthenticate(reason) {
  if (!isNativePlatform()) return false;
  try {
    await BiometricAuth.authenticate({
      reason: reason || 'Подтвердите личность',
      cancelTitle: 'Отмена',
      allowDeviceCredential: false,
    });
    return true;
  } catch {
    return false;
  }
}
