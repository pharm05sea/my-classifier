/* 개인정보 가리기 (브라우저에서만 실행, 아무것도 저장하지 않음)
   이름 → [이름], 전화번호 → [전화번호], 사번 → [사번], 이메일 → [이메일]
   - 이름은 직급이 붙은 경우만 가립니다. 예: 김가나 대리 → [이름] 대리
   - 직급 없이 쓴 이름은 가려지지 않습니다. */
(function (root) {
  var PHONE = /(?<!\d)0\d{1,2}[-\s.]\d{3,4}[-\s.]\d{4}(?!\d)|(?<!\d)01\d{8,9}(?!\d)/g;
  var EXT = /내선\s?\d{3,5}/g;
  var EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
  var EMPNO =/사번\s?[:：]?\s?[A-Za-z]{0,3}\d{4,8}|(?<![A-Za-z0-9])[A-Z]{1,3}\d{5,8}(?![A-Za-z0-9])/g;
  var NAME = /(?<![가-힣])[가-힣]{2,3}(\s?)(대리|과장|차장|부장|팀장|책임|선임|수석|사원|주임|연구원|박사|님)(?![가-힣])/g;

  function mask(text) {
    return String(text)
      .replace(EMAIL, "[이메일]")
      .replace(EMPNO, "[사번]")
      .replace(EXT, "[전화번호]")
      .replace(PHONE, "[전화번호]")
      .replace(NAME, function (m, space, title) { return "[이름]" + space + title; });
  }
  root.NpdMask = { mask: mask };
})(typeof window !== "undefined" ? window : this);
