/**
 * 测试用证书（自签名，CN=example.com，SAN 含 example.com 与 www.example.com）
 *
 * 注 1：只放证书、不放私钥 —— 公钥部分本身就是公开信息，私钥一旦进仓库就得当泄漏处理
 * 注 2：本机没有在测试里现生成证书的手段（Node 无内置自签名能力），故固化一份；
 * 解析结果里的时间由 `certificate.util.spec.ts` 断言，换证书时两处一起改
 */
export const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDNjCCAh6gAwIBAgIUZoy/0q9fAwX020nqTfHYKk91k+8wDQYJKoZIhvcNAQEL
BQAwFjEUMBIGA1UEAwwLZXhhbXBsZS5jb20wHhcNMjYxMDMxMDE1ODIyWhcNMzYx
MDI4MDE1ODIyWjAWMRQwEgYDVQQDDAtleGFtcGxlLmNvbTCCASIwDQYJKoZIhvcN
AQEBBQADggEPADCCAQoCggEBAKAYbO+RV6AG5XsNec4WlBua/mUiW8AWDIVVz44o
ozPURrtxf1NSlCExvPixQGrz8NwG8+sMAthJlVNrCZMXAS7eFg4zOEsDrt1s5dQE
cpjbapvQd9GMzk6JLIkdXtoaX5YIjOURjTxbnq9UkBnTEMvt8fMvrjD+ipPGSIJQ
oTKWP69PptOOKj9SBAsfZPmNR9kI+jVgCXtBTp3ys2c01kAou3fXnVc8unEFaXOS
H+ipA6P/zodDqVousqMneKoLyv5C/bSZYpK/CwZxzMGqu1t5zdDwEIQaJNC9NdmN
gOILqOltkvm9h15WhsJJCoxM5mnGtSFg08Q1PJFyfdjBfqMCAwEAAaN8MHowHQYD
VR0OBBYEFFsi3/W5/eKcmiGVieAz6tMB2nfuMB8GA1UdIwQYMBaAFFsi3/W5/eKc
miGVieAz6tMB2nfuMA8GA1UdEwEB/wQFMAMBAf8wJwYDVR0RBCAwHoILZXhhbXBs
ZS5jb22CD3d3dy5leGFtcGxlLmNvbTANBgkqhkiG9w0BAQsFAAOCAQEAazwJG4DI
KjQ5mXfVNd2n0gFe76REcfkX2bgHjm10+7hhbiAP+ne7wI1aIV4WwH5j94idTWga
moKG2nkP9Dhq1k4Tg+IXwTMAIn5bF9BC6qDib+PbIySaTWx9Puu+x238wCGILFVa
kD/RJNirHD5dn3Ycfv/PI+SMzvYstYEZTFl4qgFKz4uUf1SO/QVhxUGekzYg5x3N
+4idG3H7ZiQbZ1qOhbCwe1dha9cZIW3JRaTXV6pmsJVt5wnsnvoJd4Kh06jt5BZ+
rzPHTq0W+wXl1YeykP9onno+gusxqf6rQ1M9lpI/PhVuD/vfvdrOU8T9LbUmZiP0
eVj3ppNxdFSc3A==
-----END CERTIFICATE-----`;
