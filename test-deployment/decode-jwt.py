#!/usr/bin/env python3
import sys
import json
import base64

def decode_jwt_payload(token):
    """Decode JWT payload with proper padding"""
    try:
        # Split the token
        parts = token.split('.')
        if len(parts) != 3:
            print("Invalid JWT format")
            return None
        
        # Get the payload (second part)
        payload = parts[1]
        
        # Add padding if needed
        padding = 4 - (len(payload) % 4)
        if padding != 4:
            payload += '=' * padding
        
        # Decode
        decoded = base64.urlsafe_b64decode(payload)
        return json.loads(decoded)
    except Exception as e:
        print(f"Error decoding JWT: {e}")
        return None

if __name__ == "__main__":
    if len(sys.argv) > 1:
        token = sys.argv[1]
    else:
        token = sys.stdin.read().strip()
    
    payload = decode_jwt_payload(token)
    if payload:
        print(json.dumps(payload, indent=2))