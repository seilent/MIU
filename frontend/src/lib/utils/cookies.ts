/**
 * Get a cookie value by name
 * @param name The name of the cookie to get
 * @returns The cookie value or null if not found
 */
export function getCookie(name: string): string | null {
  const cookies = document.cookie.split(';');
  for (let i = 0; i < cookies.length; i++) {
    const cookie = cookies[i].trim();
    if (cookie.startsWith(name + '=')) {
      return cookie.substring(name.length + 1);
    }
  }
  return null;
}

/**
 * Set a cookie with the given name and value
 * @param name The name of the cookie
 * @param value The value of the cookie
 * @param options Additional cookie options
 */
export function setCookie(
  name: string, 
  value: string, 
  options: { 
    path?: string; 
    maxAge?: number; 
    sameSite?: 'Strict' | 'Lax' | 'None'; 
    secure?: boolean;
  } = {}
): void {
  const { path = '/', maxAge, sameSite = 'Lax', secure } = options;
  
  let cookie = `${name}=${value}; path=${path}`;
  
  if (maxAge !== undefined) {
    cookie += `; max-age=${maxAge}`;
  }
  
  if (sameSite) {
    cookie += `; SameSite=${sameSite}`;
  }
  
  if (secure) {
    cookie += '; Secure';
  }
  
  document.cookie = cookie;
}

/**
 * Delete a cookie by setting its expiration date to the past
 * @param name The name of the cookie to delete
 * @param path The path of the cookie
 */
export function deleteCookie(name: string, path = '/'): void {
  document.cookie = `${name}=; path=${path}; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`;
} 