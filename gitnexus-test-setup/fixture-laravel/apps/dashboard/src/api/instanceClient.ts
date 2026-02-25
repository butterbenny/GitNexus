import axios from 'axios';

const client = axios.create({
  baseURL: 'https://example.com/api',
});

export const fetchUsersViaClient = async () => {
  return client.get('/users');
};

