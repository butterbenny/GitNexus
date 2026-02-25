export const fetchUsers = async () => {
  return fetch('/api/users');
};

export const usersIndexUrl = (): string => {
  return route('users.index');
};
