/**
 * 포커스 표시의 단일 출처. 쓸 수 있는 링은 **세 가지뿐**이고, 어느 것을 쓰는지는
 * 요소가 놓인 자리가 정한다 — 컨트롤마다 새로 조합하면(어떤 건 오프셋, 어떤 건 inset,
 * 어떤 건 ring/40) 키보드 사용자는 "지금 여기 있다"를 화면마다 다시 배워야 한다.
 *
 *   FOCUS_RING        단독 컨트롤(버튼·링크·탭·패널) — 2px 링 + 2px 오프셋
 *   FOCUS_RING_INSET  카드/표 안에서 **가장자리까지 꽉 찬** 줄 — 오프셋이 잘려서 안 보인다
 *   FIELD_FOCUS_RING  칸 안(Input·Textarea·Select·날짜 트리거) — 테두리 색까지 함께 바뀐다
 *
 * 오프셋 색은 링과 요소 사이 틈의 색이라 **요소가 놓인 면의 색**이어야 한다. 기본은
 * surface 이고, 면이 다른 곳(예: surface-muted 위에 놓인 Segmented 칸)에서만
 * `focus-visible:ring-offset-*` 한 클래스로 덮는다 — 링 자체의 규칙은 바뀌지 않는다.
 */
export const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface";

/**
 * 줄 전체가 링크/버튼인 표 행처럼 컨테이너 가장자리에 붙는 요소용. 오프셋 링은
 * `overflow-hidden` 카드에서 잘려 사라지므로 안쪽으로 그린다 — 링의 두께·색은 같다.
 */
export const FOCUS_RING_INSET =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/**
 * 칸(폼 컨트롤) 전용. 링만 바뀌면 여러 칸이 한 줄에 있을 때 어느 칸인지 가장자리로는
 * 읽히지 않으므로 테두리 색도 같이 바꾼다. 오프셋을 주지 않는 이유는 Input 과 Select 가
 * 나란히 섰을 때 한쪽만 바깥으로 1칸 더 커 보이지 않게 하기 위해서다.
 */
export const FIELD_FOCUS_RING =
  "focus-visible:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
