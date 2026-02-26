const useDownloadAccessUrl = (downloadId: number, apiUrl: string): string => {
  if (!downloadId) {
    return '';
  }

  return `${apiUrl}/dashboard/downloads/${downloadId}/access-file`;
};

export { useDownloadAccessUrl };

