export function normalizePhone(raw: string): string {
  let phone = raw.replace(/[\s\-\u2010-\u2015\u2212\uFF0D]/g, "").replace(
    /[０-９]/g,
    (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  );

  // Mobile: 090/080/070/050
  if (/^0[5789]0\d{8}$/.test(phone)) {
    phone = phone.slice(0, 3) + "-" + phone.slice(3, 7) + "-" + phone.slice(7);
  } else if (/^0800\d{7}$/.test(phone)) {
    phone = phone.slice(0, 4) + "-" + phone.slice(4, 7) + "-" + phone.slice(7);
  } else if (/^0120\d{6}$/.test(phone)) {
    phone = phone.slice(0, 4) + "-" + phone.slice(4, 7) + "-" + phone.slice(7);
  } else if (/^0\d{9}$/.test(phone)) {
    const prefix2 = phone.slice(0, 2);
    if (prefix2 === "03" || prefix2 === "06") {
      phone = phone.slice(0, 2) + "-" + phone.slice(2, 6) + "-" +
        phone.slice(6);
    } else {
      phone = phone.slice(0, 3) + "-" + phone.slice(3, 6) + "-" +
        phone.slice(6);
    }
  }

  return phone;
}
