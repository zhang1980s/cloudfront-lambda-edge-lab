#!/bin/bash

# CloudFront Canary Deployment Test Script
# Usage: ./test-canary.sh <cloudfront-domain>
# Example: ./test-canary.sh d123abc.cloudfront.net
#
# This script tests canary deployment by comparing responses from:
# 1. Primary distribution (normal requests)
# 2. Staging distribution (requests with aws-cf-cd-staging header)

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

echo "=============================================="
echo "CloudFront Canary Deployment Tests"
echo "=============================================="
echo ""
echo "Domain: $DOMAIN"
echo ""
echo "This test compares PRIMARY vs STAGING distribution responses."
echo "Staging is accessed via the 'aws-cf-cd-staging: true' header."
echo ""

# Test 1: Primary Distribution - CloudFront Function
echo "=============================================="
echo "Test 1: PRIMARY - CloudFront Function Valid Request"
echo "=============================================="
TOKEN=$(date +%s)
SIGNATURE=$(generate_signature "$TOKEN")
echo "curl -s -w 'HTTP Status: %{http_code}' -H 'X-Bot-Token: $TOKEN' -H 'X-Bot-Signature: $SIGNATURE' https://$DOMAIN/cf-function/test.html"
RESPONSE=$(curl -s -w '\nHTTP Status: %{http_code}' \
    -H "X-Bot-Token: $TOKEN" \
    -H "X-Bot-Signature: $SIGNATURE" \
    "https://$DOMAIN/cf-function/test.html")
echo "$RESPONSE"
echo ""

# Test 2: Staging Distribution - CloudFront Function (via header)
echo "=============================================="
echo "Test 2: STAGING - CloudFront Function Valid Request"
echo "=============================================="
TOKEN=$(date +%s)
SIGNATURE=$(generate_signature "$TOKEN")
echo "curl -s -w 'HTTP Status: %{http_code}' -H 'aws-cf-cd-staging: true' -H 'X-Bot-Token: $TOKEN' -H 'X-Bot-Signature: $SIGNATURE' https://$DOMAIN/cf-function/test.html"
RESPONSE=$(curl -s -w '\nHTTP Status: %{http_code}' \
    -H "aws-cf-cd-staging: true" \
    -H "X-Bot-Token: $TOKEN" \
    -H "X-Bot-Signature: $SIGNATURE" \
    "https://$DOMAIN/cf-function/test.html")
echo "$RESPONSE"
echo ""

# Test 3: Primary Distribution - Missing Headers
echo "=============================================="
echo "Test 3: PRIMARY - Missing Headers (expect 403)"
echo "=============================================="
RESPONSE=$(curl -s -w '\nHTTP Status: %{http_code}' \
    "https://$DOMAIN/cf-function/test.html")
echo "$RESPONSE"
echo ""

# Test 4: Staging Distribution - Missing Headers
echo "=============================================="
echo "Test 4: STAGING - Missing Headers (expect 403)"
echo "=============================================="
RESPONSE=$(curl -s -w '\nHTTP Status: %{http_code}' \
    -H "aws-cf-cd-staging: true" \
    "https://$DOMAIN/cf-function/test.html")
echo "$RESPONSE"
echo ""

# Latency Comparison
echo "=============================================="
echo "Latency Comparison: PRIMARY vs STAGING"
echo "=============================================="
echo ""
echo "PRIMARY Distribution Latency (5 requests):"
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

echo "STAGING Distribution Latency (5 requests):"
echo "-------------------------------------------"
printf "%-8s %-12s %-12s %-12s\n" "Request" "DNS(s)" "TTFB(s)" "Total(s)"
for i in 1 2 3 4 5; do
    TOKEN=$(date +%s)
    SIGNATURE=$(generate_signature "$TOKEN")
    TIMING=$(curl -o /dev/null -s -w "%{time_namelookup} %{time_starttransfer} %{time_total}" \
        -H "aws-cf-cd-staging: true" \
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

echo "=============================================="
echo "Canary Deployment Workflow Reminder"
echo "=============================================="
echo ""
echo "1. Deploy with canary mode:"
echo "   cdk deploy --context canary=true"
echo ""
echo "2. Test staging distribution:"
echo "   curl -H 'aws-cf-cd-staging: true' https://$DOMAIN/cf-function/test.html"
echo ""
echo "3. Monitor CloudWatch metrics for both distributions"
echo ""
echo "4. When satisfied, promote staging to primary:"
echo "   aws cloudfront update-distribution-with-staging-config \\"
echo "     --id <PRIMARY_DIST_ID> \\"
echo "     --staging-distribution-id <STAGING_DIST_ID> \\"
echo "     --if-match <ETAG>"
echo ""
echo "=============================================="
echo "Tests Complete"
echo "=============================================="
