'use client'
import { useState, useEffect } from 'react'

interface UseOfflineDetectionReturn {
  isOffline: boolean
}

export function useOfflineDetection(): UseOfflineDetectionReturn {
  const [isOffline, setIsOffline] = useState(false)

  useEffect(() => {
    setIsOffline(!navigator.onLine)

    function handleOnline() { setIsOffline(false) }
    function handleOffline() { setIsOffline(true) }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  return { isOffline }
}
