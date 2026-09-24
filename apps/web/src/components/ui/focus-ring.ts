/**
 * 포커스 표시는 **하나**다 — 2px 링 + 2px 오프셋.
 *
 * 컨트롤마다 링을 따로 쓰면(어떤 건 오프셋 있고, 어떤 건 inset, 어떤 건 아예 없고)
 * 키보드 사용자는 "지금 여기 있다"를 매번 다시 배워야 한다. Button 이 쓰던 방식을
 * 그대로 단일 출처로 올리고, 직접 만든 `<button>`·`<a>`·`<select>` 도 전부 이걸 쓴다.
 *
 * 오프셋 색은 링과 요소 사이 틈의 색이라 **요소가 놓인 면의 색**이어야 한다. 기본은
 * surface 이고, 면이 다른 곳(예: surface-muted 위에 놓인 Segmented 칸)에서만
 * `focus-visible:ring-offset-*` 한 클래스로 덮는다 — 링 자체의 규칙은 바뀌지 않는다.
 */
export const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface";
