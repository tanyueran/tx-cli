<template>
  <div>
    <div>
      <router-link to="/">Home</router-link> |
      <router-link to="/about">About</router-link>
    </div>
    <div>
      <router-view />
    </div>
  </div>
</template>

<script setup lang="ts"></script>

<style scoped></style>
