import { useAuthStore } from '@/lib/store/authStore';

/**
 * Check if the current user has admin role
 */
export function useIsAdmin(): boolean {
  const { user } = useAuthStore();
  
  if (!user || !user.roles) {
    return false;
  }
  
  return user.roles.includes('admin');
}

/**
 * Check if a user has admin role (static version)
 */
export function isUserAdmin(user: { roles?: string[] } | null): boolean {
  if (!user || !user.roles) {
    return false;
  }
  
  return user.roles.includes('admin');
}