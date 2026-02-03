#!/bin/bash

# CloudFront Edge Function Comparison Lab - Test Script
# Usage: ./test-requests.sh <cloudfront-domain>
# Example: ./test-requests.sh d123abc.cloudfront.net

set -e

# Configuration
SECRET_KEY="my-secret-key-2024"
# AES-256-GCM key (32 bytes = 64 hex characters)
AES_KEY_HEX="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
DOMAIN="${1:-}"

if [ -z "$DOMAIN" ]; then
    echo "Usage: $0 <cloudfront-domain>"
    echo "Example: $0 d123abc.cloudfront.net"
    exit 1
fi

# Generate valid token and signature (HMAC)
generate_signature() {
    local token="$1"
    echo -n "$token" | openssl dgst -sha256 -hmac "$SECRET_KEY" | awk '{print $2}'
}

# Generate AES-GCM encrypted token
# Format: <nonce_hex>:<ciphertext_hex>:<auth_tag_hex>
generate_aesgcm_token() {
    local timestamp="$1"
    local device="${2:-test-device-001}"

    # Create JSON payload
    local payload="{\"ts\":${timestamp},\"device\":\"${device}\",\"data\":\"test\"}"

    # Generate random 12-byte nonce
    local nonce_hex=$(openssl rand -hex 12)

    # Convert hex key to binary and encrypt with AES-256-GCM
    # OpenSSL outputs: ciphertext + tag (tag is last 16 bytes)
    local encrypted=$(echo -n "$payload" | openssl enc -aes-256-gcm \
        -K "$AES_KEY_HEX" \
        -iv "$nonce_hex" \
        2>/dev/null | xxd -p | tr -d '\n')

    # Split encrypted output: ciphertext (all but last 32 hex chars) and tag (last 32 hex chars = 16 bytes)
    local encrypted_len=${#encrypted}
    local tag_start=$((encrypted_len - 32))
    local ciphertext_hex="${encrypted:0:$tag_start}"
    local auth_tag_hex="${encrypted:$tag_start:32}"

    echo "${nonce_hex}:${ciphertext_hex}:${auth_tag_hex}"
}

# Current timestamp
TOKEN=$(date +%s)
SIGNATURE=$(generate_signature "$TOKEN")

echo "=============================================="
echo "CloudFront Edge Function Comparison Lab Tests"
echo "=============================================="
echo ""
echo "Domain: $DOMAIN"
echo "Token: $TOKEN"
echo "Signature: $SIGNATURE"
echo ""

# Test 1: CloudFront Function with valid headers
echo "=============================================="
echo "Test 1: CloudFront Function - Valid Request"
echo "=============================================="
echo "curl -s -w 'HTTP Status: %{http_code}' -H 'X-Bot-Token: $TOKEN' -H 'X-Bot-Signature: $SIGNATURE' https://$DOMAIN/cf-function/test.html"
RESPONSE=$(curl -s -w '\nHTTP Status: %{http_code}' \
    -H "X-Bot-Token: $TOKEN" \
    -H "X-Bot-Signature: $SIGNATURE" \
    "https://$DOMAIN/cf-function/test.html")
echo "$RESPONSE"
echo ""

# Test 2: CloudFront Function with missing headers
echo "=============================================="
echo "Test 2: CloudFront Function - Missing Headers (expect 403)"
echo "=============================================="
RESPONSE=$(curl -s -w '\nHTTP Status: %{http_code}' \
    "https://$DOMAIN/cf-function/test.html")
echo "$RESPONSE"
echo ""

# Test 3: CloudFront Function with invalid signature
echo "=============================================="
echo "Test 3: CloudFront Function - Invalid Signature (expect 403)"
echo "=============================================="
RESPONSE=$(curl -s -w '\nHTTP Status: %{http_code}' \
    -H "X-Bot-Token: $TOKEN" \
    -H "X-Bot-Signature: invalid-signature-12345" \
    "https://$DOMAIN/cf-function/test.html")
echo "$RESPONSE"
echo ""

# Test 4: Lambda@Edge with valid headers
echo "=============================================="
echo "Test 4: Lambda@Edge - Valid Request"
echo "=============================================="
# Regenerate token for fresh timestamp
TOKEN=$(date +%s)
SIGNATURE=$(generate_signature "$TOKEN")
RESPONSE=$(curl -s -w '\nHTTP Status: %{http_code}' \
    -H "X-Bot-Token: $TOKEN" \
    -H "X-Bot-Signature: $SIGNATURE" \
    "https://$DOMAIN/lambda-edge/test.html")
echo "$RESPONSE"
echo ""

# Test 5: Lambda@Edge with missing headers
echo "=============================================="
echo "Test 5: Lambda@Edge - Missing Headers (expect 403)"
echo "=============================================="
RESPONSE=$(curl -s -w '\nHTTP Status: %{http_code}' \
    "https://$DOMAIN/lambda-edge/test.html")
echo "$RESPONSE"
echo ""

# Test 6: Lambda@Edge with invalid signature
echo "=============================================="
echo "Test 6: Lambda@Edge - Invalid Signature (expect 403)"
echo "=============================================="
RESPONSE=$(curl -s -w '\nHTTP Status: %{http_code}' \
    -H "X-Bot-Token: $TOKEN" \
    -H "X-Bot-Signature: invalid-signature-12345" \
    "https://$DOMAIN/lambda-edge/test.html")
echo "$RESPONSE"
echo ""

# Test 7: Expired token test (optional - requires waiting or using old timestamp)
echo "=============================================="
echo "Test 7: CloudFront Function - Expired Token (expect 403)"
echo "=============================================="
OLD_TOKEN="1000000000"  # Very old timestamp
OLD_SIGNATURE=$(generate_signature "$OLD_TOKEN")
RESPONSE=$(curl -s -w '\nHTTP Status: %{http_code}' \
    -H "X-Bot-Token: $OLD_TOKEN" \
    -H "X-Bot-Signature: $OLD_SIGNATURE" \
    "https://$DOMAIN/cf-function/test.html")
echo "$RESPONSE"
echo ""

# ============================================
# AES-GCM Tests (Lambda@Edge)
# ============================================
echo ""
echo "=============================================="
echo "AES-GCM ENCRYPTED TOKEN TESTS"
echo "=============================================="
echo ""

# Test 8: AES-GCM with valid encrypted token
echo "=============================================="
echo "Test 8: AES-GCM Lambda@Edge - Valid Encrypted Token"
echo "=============================================="
AESGCM_TIMESTAMP=$(date +%s)
AESGCM_TOKEN=$(generate_aesgcm_token "$AESGCM_TIMESTAMP" "test-device-001")
echo "Payload: {\"ts\":${AESGCM_TIMESTAMP},\"device\":\"test-device-001\",\"data\":\"test\"}"
echo "Token: $AESGCM_TOKEN"
RESPONSE=$(curl -s -w '\nHTTP Status: %{http_code}' \
    -H "X-Auth-Token: $AESGCM_TOKEN" \
    "https://$DOMAIN/aes-gcm/test.html")
echo "$RESPONSE"
echo ""

# Test 9: AES-GCM with missing header
echo "=============================================="
echo "Test 9: AES-GCM Lambda@Edge - Missing Header (expect 403)"
echo "=============================================="
RESPONSE=$(curl -s -w '\nHTTP Status: %{http_code}' \
    "https://$DOMAIN/aes-gcm/test.html")
echo "$RESPONSE"
echo ""

# Test 10: AES-GCM with invalid/corrupted token
echo "=============================================="
echo "Test 10: AES-GCM Lambda@Edge - Invalid Token (expect 403)"
echo "=============================================="
RESPONSE=$(curl -s -w '\nHTTP Status: %{http_code}' \
    -H "X-Auth-Token: invalid:corrupted:token" \
    "https://$DOMAIN/aes-gcm/test.html")
echo "$RESPONSE"
echo ""

# Test 11: AES-GCM with expired timestamp (inside encrypted payload)
echo "=============================================="
echo "Test 11: AES-GCM Lambda@Edge - Expired Token (expect 403)"
echo "=============================================="
OLD_AESGCM_TOKEN=$(generate_aesgcm_token "1000000000" "old-device")
RESPONSE=$(curl -s -w '\nHTTP Status: %{http_code}' \
    -H "X-Auth-Token: $OLD_AESGCM_TOKEN" \
    "https://$DOMAIN/aes-gcm/test.html")
echo "$RESPONSE"
echo ""

# Test 12: AES-GCM with tampered ciphertext (should fail auth)
echo "=============================================="
echo "Test 12: AES-GCM Lambda@Edge - Tampered Ciphertext (expect 403)"
echo "=============================================="
# Generate valid token then modify ciphertext
VALID_TOKEN=$(generate_aesgcm_token "$(date +%s)" "test-device")
# Tamper with the middle part (ciphertext)
TAMPERED_TOKEN=$(echo "$VALID_TOKEN" | sed 's/:.\{10\}/:0000000000/')
RESPONSE=$(curl -s -w '\nHTTP Status: %{http_code}' \
    -H "X-Auth-Token: $TAMPERED_TOKEN" \
    "https://$DOMAIN/aes-gcm/test.html")
echo "$RESPONSE"
echo ""

echo "=============================================="
echo "Latency Comparison (5 requests each)"
echo "=============================================="
echo ""
echo "CloudFront Function Latency:"
echo "-------------------------------------------"
printf "%-8s %-12s %-12s %-12s\n" "Request" "DNS(s)" "TTFB(s)" "Total(s)"
for i in 1 2 3 4 5; do
    TOKEN=$(date +%s)
    SIGNATURE=$(generate_signature "$TOKEN")
    TIMING=$(curl -o /dev/null -s -w "%{time_namelookup} %{time_starttransfer} %{time_total}" \
        -H "X-Bot-Token: $TOKEN" \
        -H "X-Bot-Signature: $SIGNATURE" \
        "https://$DOMAIN/cf-function/test.html")
    DNS=$(echo $TIMING | awk '{print $1}')
    TTFB=$(echo $TIMING | awk '{print $2}')
    TOTAL=$(echo $TIMING | awk '{print $3}')
    printf "%-8s %-12s %-12s %-12s\n" "#$i" "$DNS" "$TTFB" "$TOTAL"
    sleep 0.5
done
echo ""

echo "Lambda@Edge (HMAC) Latency:"
echo "-------------------------------------------"
printf "%-8s %-12s %-12s %-12s\n" "Request" "DNS(s)" "TTFB(s)" "Total(s)"
for i in 1 2 3 4 5; do
    TOKEN=$(date +%s)
    SIGNATURE=$(generate_signature "$TOKEN")
    TIMING=$(curl -o /dev/null -s -w "%{time_namelookup} %{time_starttransfer} %{time_total}" \
        -H "X-Bot-Token: $TOKEN" \
        -H "X-Bot-Signature: $SIGNATURE" \
        "https://$DOMAIN/lambda-edge/test.html")
    DNS=$(echo $TIMING | awk '{print $1}')
    TTFB=$(echo $TIMING | awk '{print $2}')
    TOTAL=$(echo $TIMING | awk '{print $3}')
    printf "%-8s %-12s %-12s %-12s\n" "#$i" "$DNS" "$TTFB" "$TOTAL"
    sleep 0.5
done
echo ""

echo "Lambda@Edge (AES-GCM) Latency:"
echo "-------------------------------------------"
printf "%-8s %-12s %-12s %-12s\n" "Request" "DNS(s)" "TTFB(s)" "Total(s)"
for i in 1 2 3 4 5; do
    AESGCM_TOKEN=$(generate_aesgcm_token "$(date +%s)" "latency-test-$i")
    TIMING=$(curl -o /dev/null -s -w "%{time_namelookup} %{time_starttransfer} %{time_total}" \
        -H "X-Auth-Token: $AESGCM_TOKEN" \
        "https://$DOMAIN/aes-gcm/test.html")
    DNS=$(echo $TIMING | awk '{print $1}')
    TTFB=$(echo $TIMING | awk '{print $2}')
    TOTAL=$(echo $TIMING | awk '{print $3}')
    printf "%-8s %-12s %-12s %-12s\n" "#$i" "$DNS" "$TTFB" "$TOTAL"
    sleep 0.5
done
echo ""

echo "Note: TTFB (Time To First Byte) includes edge function execution time."
echo "      First request may show Lambda@Edge cold start latency."
echo "      AES-GCM decryption adds ~1-5ms compared to HMAC."
echo ""

echo "=============================================="
echo "Tests Complete"
echo "=============================================="
