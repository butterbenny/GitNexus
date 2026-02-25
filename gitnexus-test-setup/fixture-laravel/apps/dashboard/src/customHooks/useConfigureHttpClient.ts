import Axios from 'axios';

export const useConfigureHttpClient = () => {
  const apiUrl = 'https://example.com';
  Axios.defaults.baseURL = `${apiUrl}/api`;
};

