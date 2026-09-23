let fallbackSeq = 0;

/**
 * 편집·삭제 가능한 행의 React key. 인덱스를 key 로 쓰면 가운데 행을 지울 때
 * 아래 행의 입력 상태(포커스·커서)가 한 칸씩 밀려 엉뚱한 행에 붙는다.
 *
 * crypto.randomUUID 는 보안 컨텍스트(HTTPS·localhost)에서만 있다 — 사내망 http 로
 * 콘솔을 여는 설치도 있어서 없으면 순번으로 대신한다. 한 화면 안에서만 유일하면 된다.
 */
export function newRowId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  fallbackSeq += 1;
  return `row-${fallbackSeq}`;
}
