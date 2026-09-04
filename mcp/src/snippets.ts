/** 플랫폼별 통합 스니펫 (실제 키가 채워져 AI 가 그대로 삽입) */
export function integrationSnippet(platform: string, baseUrl: string, apiKey: string): string {
  switch (platform) {
    case "web":
      return `import { NotikitWeb } from "@notikit/web-sdk";
const notikit = new NotikitWeb({ baseUrl: "${baseUrl}", apiKey: "${apiKey}", vapidPublicKey: "<VAPID_PUBLIC_KEY>" });
if (NotikitWeb.isSupported()) await notikit.register();`;
    case "react":
      return `import { NotikitProvider, usePushRegistration } from "@notikit/react";
<NotikitProvider config={{ baseUrl: "${baseUrl}", apiKey: "${apiKey}", vapidPublicKey: "<VAPID_PUBLIC_KEY>" }}>
  {/* usePushRegistration() 로 등록 버튼 연결 */}
</NotikitProvider>`;
    case "react-native":
      return `import messaging from "@react-native-firebase/messaging";
import { NotikitReactNative } from "@notikit/react-native";
const notikit = new NotikitReactNative({ baseUrl: "${baseUrl}", apiKey: "${apiKey}" });
const token = await messaging().getToken();
await notikit.register(token, "android", "user-123");`;
    case "flutter":
      return `final notikit = Notikit(baseUrl: "${baseUrl}", apiKey: "${apiKey}");
final token = await FirebaseMessaging.instance.getToken();
await notikit.registerDevice(token: token!, platform: "android", externalId: "user-123");`;
    case "android":
      return `val notikit = Notikit(baseUrl = "${baseUrl}", apiKey = "${apiKey}")
FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
  notikit.registerDevice(token = token, platform = "android", externalId = "user-123")
}`;
    case "swift":
      return `let notikit = Notikit(baseUrl: "${baseUrl}", apiKey: "${apiKey}")
try await notikit.registerDevice(token: fcmToken, platform: "ios", externalId: "user-123")`;
    default:
      return `// 지원 플랫폼: web, react, react-native, flutter, android, swift`;
  }
}
