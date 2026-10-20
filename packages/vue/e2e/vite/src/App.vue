<template>
  <nav aria-label="Main">
    <RouterLink to="/">Home</RouterLink>
    <RouterLink to="/notes">Notes</RouterLink>
    <RouterLink to="/reports">Reports</RouterLink>
  </nav>
  <main>
    <RouterView />
  </main>
</template>
