import Axios from 'axios';

type LoginParams = {
  email: string;
  password: string;
};

export const getAuthToken = (loginCredentials: LoginParams, apiUrl = '') => {
  return Axios.post(
    '/login',
    loginCredentials,
    {
      baseURL: `${apiUrl}/api-mobile`,
    },
  );
};

