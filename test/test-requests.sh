#!/bin/bash

# CloudFront Edge Function Comparison Lab - Test Script
# Usage: ./test-requests.sh <cloudfront-domain>
# Example: ./test-requests.sh d123abc.cloudfront.net

set -e

# Configuration
SECRET_KEY="my-secret-key-2024"
DOMAIN="${1:-}"

if [ -z "$DOMAIN" ]; then
    echo "Usage: $0 <cloudfront-domain>"
    echo "Example: $0 d123abc.cloudfront.net"
    exit 1
fi

# Generate valid token and signature
generate_signature() {
    local token="$1"
    echo -n "$token" | openssl dgst -sha256 -hmac "$SECRET_KEY" | awk '{print $2}'
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

echo "Lambda@Edge Latency:"
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

echo "Note: TTFB (Time To First Byte) includes edge function execution time."
echo "      First request may show Lambda@Edge cold start latency."
echo ""

echo "=============================================="
echo "Tests Complete"
echo "=============================================="
