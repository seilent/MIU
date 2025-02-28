<IfModule mod_ssl.c>
<VirtualHost *:443>
    ProxyPreserveHost On
    ProxyRequests Off
    
    # Enable WebSocket proxy for both frontend and backend
    RewriteEngine On
    
    # WebSocket proxy for backend paths
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteCond %{REQUEST_URI} ^/backend/(.*)$ [NC]
    RewriteRule ^/backend/(.*)$ ws://127.0.0.1:3000/$1 [P,L]
    
    # WebSocket proxy for frontend paths
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteCond %{REQUEST_URI} !^/backend/ [NC]
    RewriteRule /(.*) ws://127.0.0.1:3300/$1 [P,L]
    
    # Remove any existing CORS headers first
    Header unset Access-Control-Allow-Origin
    Header unset Access-Control-Allow-Methods
    Header unset Access-Control-Allow-Headers
    Header unset Access-Control-Allow-Credentials
    
    # Set CORS headers for the backend paths
    <LocationMatch "^/backend/">
    Header always set Access-Control-Allow-Origin "https://miu.gacha.boo"
    Header always set Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS"
    Header always set Access-Control-Allow-Headers "Content-Type, Authorization, X-Requested-With, X-Internal-Request, Upgrade, Connection, Last-Event-ID, Accept, Accept-Version"
    Header always set Access-Control-Allow-Credentials "true"
    Header always set Access-Control-Expose-Headers "Content-Type, Content-Length, X-Initial-Position, X-Playback-Start, X-Track-Id, X-Track-Duration, Set-Cookie, Authorization"
    
    # Add specific headers for SSE
    SetEnvIf Accept "^text/event-stream" IS_SSE
    Header always set Cache-Control "no-cache, no-store, must-revalidate" env=IS_SSE
    Header always set Connection "keep-alive" env=IS_SSE
    
    # Handle OPTIONS requests for CORS preflight
    RewriteEngine On
    RewriteCond %{REQUEST_METHOD} OPTIONS
    RewriteRule ^(.*)$ $1 [R=200,L]
    
    # Ensure headers are set for error responses too
    Header always set Access-Control-Allow-Origin "https://miu.gacha.boo" "expr=%{REQUEST_STATUS} >= 400"
    Header always set Access-Control-Allow-Credentials "true" "expr=%{REQUEST_STATUS} >= 400"
    </LocationMatch>

    # Add specific proxy settings for SSE connections
    <LocationMatch "^/backend/api/music/state/live">
        ProxyPass http://127.0.0.1:3000/api/music/state/live timeout=3600 keepalive=On
        ProxyPassReverse http://127.0.0.1:3000/api/music/state/live
        
        # Add specific headers for SSE
        Header always set Cache-Control "no-cache, no-store, must-revalidate"
        Header always set Connection "keep-alive"
        Header always set Access-Control-Allow-Origin "https://miu.gacha.boo"
        Header always set Access-Control-Allow-Credentials "true"
        Header always set Access-Control-Allow-Headers "Content-Type, Authorization, X-Requested-With, X-Internal-Request, Last-Event-ID"
        Header always set Access-Control-Expose-Headers "Content-Type, Content-Length"
    </LocationMatch>

    # Add specific proxy settings for presence updates
    <LocationMatch "^/backend/api/discord/presence">
        ProxyPass http://127.0.0.1:3000/api/presence/heartbeat
        ProxyPassReverse http://127.0.0.1:3000/api/presence/heartbeat
        
        # Add specific headers for presence updates
        Header always set Access-Control-Allow-Origin "https://miu.gacha.boo"
        Header always set Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS"
        Header always set Access-Control-Allow-Headers "Content-Type, Authorization, X-Requested-With, X-Internal-Request, X-Keep-Playing"
        Header always set Access-Control-Allow-Credentials "true"
        Header always set Access-Control-Expose-Headers "Content-Type, Content-Length"
        
        # Handle OPTIONS preflight
        RewriteEngine On
        RewriteCond %{REQUEST_METHOD} OPTIONS
        RewriteRule ^(.*)$ $1 [R=200,L]
    </LocationMatch>
    
    # Set headers for reverse proxy
    RequestHeader set X-Forwarded-Proto "https"
    RequestHeader set X-Forwarded-Port "443"
    RequestHeader set X-Real-IP %{REMOTE_ADDR}s
    
    # Proxy all backend requests to the API server
    ProxyPass /backend/ http://127.0.0.1:3000/
    ProxyPassReverse /backend/ http://127.0.0.1:3000/
    
    # Proxy frontend (must come last)
    ProxyPass / http://127.0.0.1:3300/
    ProxyPassReverse / http://127.0.0.1:3300/
    
    # Handle redirects properly
    ProxyPassReverseCookieDomain localhost miu.gacha.boo
    ProxyPassReverseCookiePath / /
    
    # SSL Configuration
    SSLEngine on
    ServerName miu.gacha.boo
    Include /etc/letsencrypt/options-ssl-apache.conf
    SSLCertificateFile /etc/letsencrypt/live/miu.gacha.boo/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/miu.gacha.boo/privkey.pem
</VirtualHost>

# Redirect sv-miu.gacha.boo to miu.gacha.boo/backend
<VirtualHost *:443>
    ServerName sv-miu.gacha.boo
    SSLEngine on
    SSLCertificateFile /etc/letsencrypt/live/sv-miu.gacha.boo/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/sv-miu.gacha.boo/privkey.pem
    
    RewriteEngine On
    RewriteRule ^/(.*)$ https://miu.gacha.boo/backend/$1 [R=301,L]
</VirtualHost>
</IfModule>